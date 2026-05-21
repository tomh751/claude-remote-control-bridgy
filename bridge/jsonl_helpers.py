"""Utilities for parsing Claude Code's per-session `.jsonl` files.

Claude Code writes each conversation to
`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` as it goes,
appending one JSON line per event (user message, assistant message,
tool use, tool result, system init, etc.). The bridge reads these
files for two purposes:

  1. History replay — fetching past conversation events to re-render
     them when the user resumes a session from the hamburger drawer.
  2. Context-window meter — approximating "how full is the conversation
     right now" so the mobile donut matches VSCode's `/context` display.

The token count is a CHARACTER-based approximation (chars / 3.5 plus a
fixed 3000-token overhead for system prompt + tool schemas). Claude
Code's actual `/context` uses Anthropic's tokenizer which we don't have
access to from the bridge, but chars/3.5 lands within ~5% of the real
count for English/code content and is good enough for the donut.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


# Per-session jsonl files live under this root, one folder per project cwd.
_CLAUDE_SESSIONS_ROOT = Path.home() / ".claude" / "projects"

# Claude Code's encoding for the cwd folder name: replace EVERY
# non-alphanumeric character with `-`. So `C:\Users\X\AI Projects\foo`
# becomes `C--Users-X-AI-Projects-foo`.
_ENCODE_RE = re.compile(r"[^A-Za-z0-9]")


def _encode_cwd(cwd: Path) -> str:
    return _ENCODE_RE.sub("-", str(cwd))


def find_session_dir(cwd: Path) -> Path | None:
    """Find `~/.claude/projects/<encoded-cwd>/` for a given project cwd.

    Returns None when no matching folder exists (the session may not
    have been started yet, or Claude Code's encoding changed between
    versions). Match is case-insensitive and tolerates suffix-equality
    to absorb minor encoding drift.
    """
    if not _CLAUDE_SESSIONS_ROOT.is_dir():
        return None
    target = _encode_cwd(cwd)
    target_lc = target.lower()
    # Prefer exact match. The `endswith` fallback handles minor encoding
    # drift (Claude Code prepends an extra leading `-` on some Windows
    # paths), but require a `-` separator boundary so projects whose
    # encoding is a strict suffix of another's (e.g. `foo` would otherwise
    # match the tail of `bar-foo`) don't collide and silently resolve to
    # the wrong project's session store. Reported in audit 2026-05-21.
    exact: Path | None = None
    fallback: Path | None = None
    for d in _CLAUDE_SESSIONS_ROOT.iterdir():
        if not d.is_dir():
            continue
        name_lc = d.name.lower()
        if name_lc == target_lc:
            exact = d
            break
        if name_lc.endswith("-" + target_lc):
            fallback = d
    return exact or fallback


# Long tool_result outputs (file dumps, bash logs) are typically
# truncated or summarised by Claude's auto-compact before they pile up
# in the active context — only the most recent ~couple of results stay
# verbatim. We cap individual tool_result counts so we don't inflate
# the "current context size" estimate with content that's no longer
# resident in the model's attention.
_TOOL_RESULT_CAP_CHARS = 4500


def count_event_chars(ev: dict) -> int:
    """Count visible text characters in a user/assistant event's content.

    Walks every content block (text, thinking, tool_use input,
    tool_result) and sums their lengths. tool_result blocks are
    individually capped at `_TOOL_RESULT_CAP_CHARS` because Claude's
    auto-compact drops/summarises older large outputs — leaving them
    fully counted would massively over-report context for any session
    that ever did a Read on a big file. The returned number is used
    to approximate tokens — divide by ~3.5 for Claude's tokenization.
    """
    total = 0
    msg_obj = ev.get("message") or {}
    content = msg_obj.get("content")
    if isinstance(content, str):
        total += len(content)
    elif isinstance(content, list):
        for blk in content:
            if not isinstance(blk, dict):
                continue
            btype = blk.get("type")
            if btype == "text":
                total += len(blk.get("text") or "")
            elif btype == "thinking":
                total += len(blk.get("thinking") or "")
            elif btype == "tool_use":
                total += len(blk.get("name") or "")
                try:
                    total += min(len(json.dumps(blk.get("input") or {})), _TOOL_RESULT_CAP_CHARS)
                except (TypeError, ValueError):
                    pass
            elif btype == "tool_result":
                rc = blk.get("content")
                tr_chars = 0
                if isinstance(rc, str):
                    tr_chars = len(rc)
                elif isinstance(rc, list):
                    for b in rc:
                        if isinstance(b, dict):
                            tr_chars += len(b.get("text") or "")
                total += min(tr_chars, _TOOL_RESULT_CAP_CHARS)
    return total


# Chars-per-token ratio for Claude's tokenizer. Re-calibrated against
# a long real session whose VSCode `/context` showed ~164k used. Raw
# post-compact char count was 1,051,449 — the ratio that lands at
# 164k is ~6.4. Code-heavy content (JSON, lots of identifiers,
# whitespace) tokenizes more compactly than the chars/5 estimate, so
# the previous 5.0 over-reported by 20-30%. 6.4 lands within a couple
# percent of VSCode for code-heavy sessions and is still conservative
# for prose-heavy sessions (where the real ratio is closer to 4).
_CHARS_PER_TOKEN = 6.4

# Fixed overhead for system prompt + tool schemas + agent definitions.
# These aren't in the per-message content but DO count against the
# context window. ~1500 is a rough fit observed empirically (lower
# than the previous 3000 because the higher chars/token ratio above
# already absorbs some of the prior over-estimate).
_FIXED_OVERHEAD_TOKENS = 1500


def count_session_context(session_id: str, cwd: Path) -> int:
    """Return the session's CURRENT context-window size in tokens.

    We use a char-based estimate (total user + assistant text divided
    by `_CHARS_PER_TOKEN`, plus a fixed `_FIXED_OVERHEAD_TOKENS` for
    the system prompt + tool schemas). The previous API-usage path
    was abandoned because Claude 4's `usage.cache_read_input_tokens`
    field reports cumulative cache reads across the multiple cache
    blocks a prompt references — easily 800k+ on a 200k-context
    model — which made the mobile donut diverge from VSCode's
    `/context` by hundreds of percent.

    Compact boundaries reset the char counter: events before a
    `subtype: "compact_boundary"` event (or before an
    `isCompactSummary: true` user message) are OUT of the current
    context.

    Returns 0 when the session can't be located or the file is empty.
    """
    folder = find_session_dir(cwd)
    if folder is None:
        return 0
    f = folder / f"{session_id}.jsonl"
    if not f.is_file():
        return 0
    total_chars = 0
    try:
        with f.open("r", encoding="utf-8") as fh:
            for line in fh:
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                # Compact boundary: reset char counter — events before
                # the boundary are no longer in Claude's active context.
                if ev.get("type") == "system" and ev.get("subtype") == "compact_boundary":
                    total_chars = 0
                    continue
                if ev.get("isCompactSummary"):
                    total_chars = count_event_chars(ev)
                    continue
                et = ev.get("type")
                if et in ("user", "assistant"):
                    total_chars += count_event_chars(ev)
    except OSError:
        return 0
    if total_chars == 0:
        return 0
    return int(total_chars / _CHARS_PER_TOKEN) + _FIXED_OVERHEAD_TOKENS
