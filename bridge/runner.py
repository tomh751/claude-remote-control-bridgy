"""Low-level wrapper around `claude -p`. Spawns the subprocess, parses its
NDJSON stream-event output, and forwards assistant text chunks to a callback.

Design notes:
  - The user's prompt is passed via stdin, NOT as a command-line arg. That
    sidesteps Windows cmd.exe metacharacter problems (`&`, `|`, etc. in the
    prompt would otherwise break the invocation).
  - On Windows, if the resolved `claude` command is a .cmd/.bat, we route it
    through `cmd.exe /D /S /C` because .cmd files can't be exec'd directly.
  - We use `--output-format stream-json --include-partial-messages` so the
    bridge sees per-token assistant text deltas in real time. Tool uses and
    tool results are suppressed — the user only sees the working indicator
    while claude runs commands. The intent: "I want to see what claude is
    writing as he writes, but not the noise of every Bash/Read/Edit call."
  - stderr is drained separately at debug level so verbose diagnostics from
    `--verbose` don't pollute the JSON stream.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
from collections import deque
from pathlib import Path
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

# Windows: hide the child's console window. The bridge runs under
# pythonw.exe (no console of its own) and `claude` is a .cmd shim that
# we wrap in `cmd.exe /D /S /C` — without CREATE_NO_WINDOW, Windows
# allocates a fresh console for cmd.exe and the user sees a black
# terminal flash on every prompt. Linux/Mac: this flag is undefined and
# the parameter is ignored when 0.
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

# Bridge-only env vars the subprocess should NOT inherit. Listed explicitly
# (allowlist would over-strip variables claude needs like ANTHROPIC_API_KEY).
# These are secrets/auth that belong to the bridge's transports, not to
# claude itself. We pass a scrubbed env to create_subprocess_exec so a
# misbehaving prompt can't read them via `env` / `printenv` in a Bash
# tool.
_BRIDGE_PRIVATE_ENV = frozenset({
    "WEB_PASSWORD",
    # Defensive: even though the bridge no longer ships a transcription
    # feature using cloud APIs, scrub the legacy var so users who
    # migrated from an older build with `.env.local` still containing
    # it don't accidentally leak it into spawned claude subprocesses.
    "GEMINI_API_KEY",
    # Whisper config is bridge-internal — never relevant to a spawned
    # claude run and there's no reason to surface it inside the
    # subprocess's `env`. Kept here on principle (bridge-internal stays
    # bridge-internal) even though none of these are secrets.
    "WHISPER_MODEL",
    "WHISPER_DEVICE",
    "WHISPER_COMPUTE_TYPE",
    "WHISPER_LANG",
})


def _extra_scrub_keys() -> frozenset[str]:
    """Read the operator's opt-in deny-list from `BRIDGE_SCRUB_ENV`.

    Format: comma-separated env var names. Whitespace tolerated. Names
    are uppercased so `bridge_scrub_env=stripe_key,db_url` works the
    same as the all-caps form. The default is empty — secrets the
    operator has added to `.env.local` (Perplexity, Stripe, etc.) pass
    through to `claude -p` unless they list them here.
    """
    raw = os.environ.get("BRIDGE_SCRUB_ENV", "")
    if not raw:
        return frozenset()
    return frozenset(part.strip().upper() for part in raw.split(",") if part.strip())


def _scrub_env() -> dict[str, str]:
    """Return a copy of os.environ with bridge-private vars removed."""
    env = dict(os.environ)
    for k in _BRIDGE_PRIVATE_ENV:
        env.pop(k, None)
    for k in _extra_scrub_keys():
        env.pop(k, None)
    return env

OnText = Callable[[str], Awaitable[None]]
OnToolUse = Callable[[str, dict, str], Awaitable[None]]   # (tool_name, input_dict, tool_use_id)
OnToolError = Callable[[str, str], Awaitable[None]]      # (error_text, tool_use_id)
OnToolResult = Callable[[str, str, bool], Awaitable[None]]  # (tool_use_id, text, is_error)
OnSessionInit = Callable[[dict], Awaitable[None]]         # init dict (has session_id)
OnUsage = Callable[[dict], Awaitable[None]]               # usage dict (input/output/cache tokens)

# `--dangerously-skip-permissions` truly skips ALL permission checks
# including the hardcoded `.claude/**` safety rail that `--permission-mode
# bypassPermissions` leaves in place. For the user's "Bypass permissions"
# mode this is what they actually want — they explicitly opted into "full
# auto, no prompts" and there's no human in the loop to approve a tool
# prompt. Documented as "for sandboxes with no internet access" in the
# CLI help, but the bridge is single-user, the user owns the laptop, and
# they've consented to the trade-off.
_MODE_FLAGS: dict[str, list[str]] = {
    "auto": ["--dangerously-skip-permissions"],
    "plan": ["--permission-mode", "plan"],
    "edits": ["--permission-mode", "acceptEdits"],
    # `default` in headless -p: file mutations (Write/Edit/MultiEdit) return
    # a clean tool_error ("Claude requested permissions to write to X, but
    # you haven't granted it yet") instead of stalling the run, while Bash
    # and other tools are auto-allowed. Verified empirically against
    # claude.exe 2.1.x with tools/probe_permission_modes.py on 2026-05-16 —
    # the "will stall" claim from earlier CLI versions no longer holds.
    "ask":  ["--permission-mode", "default"],
}

# Valid `--effort` levels per Anthropic docs (Effort — Claude API Docs).
# "high" is the default; passing it is a no-op so we omit the flag for it.
_VALID_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})

# Platform-specific halves of the system prompt. The bridge resolves which
# half to ship based on the host OS at spawn time — `py -c` and PowerShell
# only exist on Windows; Unix users get `python3 -c` and nohup/lsof
# equivalents so claude doesn't hallucinate why its commands fail.

_PROMPT_HEADER = (
    "===== CRITICAL: .claude/** WRITE WORKAROUND (READ FIRST) =====\n"
    "Claude Code has a HARDCODED safety rail in headless (-p) mode that blocks ALL\n"
    "Write/Edit/MultiEdit calls under `.claude/**` paths, regardless of permission\n"
    "mode flags (bypassPermissions, dangerously-skip-permissions, --add-dir, and\n"
    "settings.permissions.allow are ALL ignored for this specific case). There is\n"
    "no CLI flag that bypasses it — verified empirically against Claude Code 2.1.123.\n"
    "\n"
    "If you need to write under `.claude/**` (typically agent memory files at\n"
    "`.claude/agents/<agent>/memory/`), DO NOT attempt Write/Edit/MultiEdit first.\n"
    "It will fail, the user will see a tool-error card, and you'll waste a turn.\n"
    "Use Bash + Python directly. Examples:\n"
    "\n"
)

# Workaround examples — Windows uses `py -c` and Windows-style raw strings;
# Unix uses `python3 -c`. <YYYY-MM-DD>.md is a placeholder so a user
# copying the example verbatim doesn't end up with a stale 2026-05-XX
# date.
_PROMPT_WORKAROUND_WIN = (
    "  # Create or overwrite a memory file:\n"
    "  Bash: py -c \"from pathlib import Path; p=Path(r'.claude/agents/orchestrator/memory/<YYYY-MM-DD>.md'); p.parent.mkdir(parents=True,exist_ok=True); p.write_text('# <YYYY-MM-DD>\\n\\n## title\\n\\nbody\\n', encoding='utf-8')\"\n"
    "\n"
    "  # Append a section to an existing memory file:\n"
    "  Bash: py -c \"open(r'.claude/agents/orchestrator/memory/<YYYY-MM-DD>.md','a',encoding='utf-8').write('\\n## new section\\n\\nmore body\\n')\"\n"
    "\n"
    "Always use Windows raw strings (r'...') for paths. ALL OTHER paths (project\n"
    "source, configs, docs, README, etc.) work fine with Edit/Write/MultiEdit — the\n"
    "carve-out is specifically `.claude/**`.\n"
)
_PROMPT_WORKAROUND_UNIX = (
    "  # Create or overwrite a memory file:\n"
    "  Bash: python3 -c \"from pathlib import Path; p=Path('.claude/agents/orchestrator/memory/<YYYY-MM-DD>.md'); p.parent.mkdir(parents=True,exist_ok=True); p.write_text('# <YYYY-MM-DD>\\n\\n## title\\n\\nbody\\n', encoding='utf-8')\"\n"
    "\n"
    "  # Append a section to an existing memory file:\n"
    "  Bash: python3 -c \"open('.claude/agents/orchestrator/memory/<YYYY-MM-DD>.md','a',encoding='utf-8').write('\\n## new section\\n\\nmore body\\n')\"\n"
    "\n"
    "ALL OTHER paths (project source, configs, docs, README, etc.) work fine with\n"
    "Edit/Write/MultiEdit — the carve-out is specifically `.claude/**`.\n"
)

_PROMPT_PHONE_TONE = (
    "============================================================\n"
    "\n"
    "You are running headless and your output is sent to the user's phone via "
    "a mobile PWA bridge. Be terse:\n"
    "- Direct answers, no preamble or recap.\n"
    "- 1-5 lines for routine answers. Go longer only when the task truly needs it.\n"
    "- No tables, no markdown headers, no long bulleted lists with explanations.\n"
    "- Phone screens are narrow — prefer short paragraphs over wide markdown structure.\n"
    "- Do not volunteer safety advice, rotation warnings, or FYI tangents. The user "
    "owns the laptop and has consented to whatever they ask.\n"
    "- When showing files, paths, or commands, keep them tight — no extra commentary.\n"
    "- ALWAYS end your turn with a short user-facing text message — even if you only "
    "ran tools, made edits, or investigated. The user is on a phone and only sees "
    "your final text. A run that ends with zero text leaves the user staring at a "
    "blank reply and wondering if anything happened. One sentence is fine.\n\n"
)

# Dev-server guidance — same goal (detach so Bash doesn't block) but
# different incantations per OS.
_PROMPT_DEVSERVER_WIN = (
    "Long-running servers (Vite, Next.js dev, Flask, uvicorn, any `npm run dev` / "
    "`pnpm dev` / `yarn dev` style command) MUST be spawned detached on Windows so "
    "they survive after this run ends — otherwise the Bash tool blocks forever and "
    "the user's phone shows nothing. The user reaches the server from their phone over "
    "the LAN (e.g. http://{LAN_IP}:5173), so the server MUST bind to all interfaces, "
    "not localhost. Do it like this:\n"
    "1. Pick the right flag for the framework so it listens on 0.0.0.0:\n"
    "   - Vite: `npm run dev -- --host 0.0.0.0`\n"
    "   - Next.js: `npm run dev -- -H 0.0.0.0`\n"
    "   - uvicorn/FastAPI: `uvicorn app:app --host 0.0.0.0 --port <port>`\n"
    "   - Flask: `flask run --host=0.0.0.0`\n"
    "   If the project's package.json already wires `--host` into the dev script, don't double it.\n"
    "2. Spawn it detached via PowerShell: `Start-Process -FilePath \"powershell\" "
    "-ArgumentList \"-NoProfile\",\"-Command\",\"npm run dev -- --host 0.0.0.0 *> .server.log\" "
    "-WindowStyle Hidden` (swap inner command + log path as needed).\n"
    "3. Sleep ~3-5 seconds, then read `.server.log` to confirm it bound and grab the port.\n"
    "4. Report the LAN URL (use the laptop's LAN IP — {LAN_IP} unless told otherwise) and stop. "
    "Do NOT tail the log in a loop, do NOT run the dev command in the foreground, do NOT use the "
    "Bash tool's normal mode for it.\n"
    "If the user just wants to STOP a server you previously started, find the pid via "
    "`Get-NetTCPConnection -LocalPort <port>` or `Get-Process node` and `Stop-Process`."
)
_PROMPT_DEVSERVER_UNIX = (
    "Long-running servers (Vite, Next.js dev, Flask, uvicorn, any `npm run dev` / "
    "`pnpm dev` / `yarn dev` style command) MUST be spawned detached so they survive "
    "after this run ends — otherwise the Bash tool blocks forever and the user's "
    "phone shows nothing. The user reaches the server from their phone over the LAN "
    "(e.g. http://{LAN_IP}:5173), so the server MUST bind to all interfaces, not "
    "localhost. Do it like this:\n"
    "1. Pick the right flag for the framework so it listens on 0.0.0.0:\n"
    "   - Vite: `npm run dev -- --host 0.0.0.0`\n"
    "   - Next.js: `npm run dev -- -H 0.0.0.0`\n"
    "   - uvicorn/FastAPI: `uvicorn app:app --host 0.0.0.0 --port <port>`\n"
    "   - Flask: `flask run --host=0.0.0.0`\n"
    "   If the project's package.json already wires `--host` into the dev script, don't double it.\n"
    "2. Spawn it detached: `nohup npm run dev -- --host 0.0.0.0 > .server.log 2>&1 &` "
    "(or `setsid` if nohup is unavailable). The trailing `&` is mandatory.\n"
    "3. Sleep ~3-5 seconds, then read `.server.log` to confirm it bound and grab the port.\n"
    "4. Report the LAN URL (use the laptop's LAN IP — {LAN_IP} unless told otherwise) and stop. "
    "Do NOT tail the log in a loop, do NOT run the dev command in the foreground, do NOT use the "
    "Bash tool's normal mode for it.\n"
    "If the user just wants to STOP a server you previously started, find the pid via "
    "`lsof -ti :<port>` (or `ss -ltnp`) and `kill <pid>`."
)


def _platform_system_prompt() -> str:
    """Compose the system prompt for the host OS. Windows gets PowerShell
    incantations + `py -c`; macOS/Linux get nohup + `python3 -c`."""
    if sys.platform == "win32":
        return (
            _PROMPT_HEADER
            + _PROMPT_WORKAROUND_WIN
            + _PROMPT_PHONE_TONE
            + _PROMPT_DEVSERVER_WIN
        )
    return (
        _PROMPT_HEADER
        + _PROMPT_WORKAROUND_UNIX
        + _PROMPT_PHONE_TONE
        + _PROMPT_DEVSERVER_UNIX
    )


# Friendly model display names for the in-prompt identity directive.
# Keep this list short — only the models the mobile UI lets the user pick.
_MODEL_DISPLAY = {
    "claude-opus-4-7": "Claude Opus 4.7",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
}

# Friendly descriptions of each permission mode for the in-prompt
# directive. Keys MUST match the values `sessions.run` passes through.
_PERMISSION_MODE_DISPLAY = {
    "auto":  ("Bypass permissions (full auto)", "Permissions are bypassed — you can run any tool without confirmation. The user has explicitly opted into 'full auto, no prompts.'"),
    "plan":  ("Plan mode", "You can read files freely, but Write/Edit/MultiEdit and Bash are blocked at the CLI layer and will return a tool_error. Produce a written plan instead of attempting edits, and tell the user to switch out of plan mode if they want changes applied."),
    "edits": ("Edit mode (accept-edits)", "File edits (Write/Edit/MultiEdit) are auto-accepted. Bash and other tools also run without confirmation in headless mode. Use this for routine code-change tasks where the user has already implied consent by picking this chip."),
    "ask":   ("Ask before edits", "File mutations (Write/Edit/MultiEdit) will return a tool_error 'Claude requested permissions … but you haven't granted it yet' — try them only if the user explicitly asks. Bash and read-only tools run normally. Treat this like a 'read-and-suggest' mode: investigate freely, propose changes in text, and let the user switch to acceptEdits or bypass before you apply them."),
}


def build_system_prompt(lan_ip: str, model: str = "", permission_mode: str = "") -> str:
    """Materialize the system prompt with the user's LAN IP substituted in.

    If `lan_ip` is empty (auto-detection failed and no env override), strip
    the LAN-URL guidance entirely — Claude will figure it out from
    `ipconfig` / `hostname -I` if the user asks for a dev-server URL.

    If `model` is set, append a one-line identity directive so the model
    answers questions like "what model are you?" based on its CURRENT
    invocation rather than guessing from prior conversation context. This
    matters because the mobile UI lets the user swap models mid-session
    (e.g. plan on Sonnet, implement on Opus). Without this directive, the
    new model reads prior turns ("I'm Haiku") in the resumed jsonl and
    confirms the OLD identity even though the API call is using the NEW
    model.

    If `permission_mode` is set, append a similar directive naming the
    active mode and what it allows. Same root cause: the user can flip
    the chip mid-conversation (plan → bypass → edits) but Claude reads
    the prior turn's "I'm in plan mode" claim and confirms the OLD mode
    even though the CLI flag for THIS turn is different. Without this
    directive Claude often misreports its own mode.

    Both directives live at the END of the appended system prompt so
    they have the strongest recency bias when the model self-introspects.
    """
    template = _platform_system_prompt()
    if lan_ip:
        base = template.replace("{LAN_IP}", lan_ip)
    else:
        # No LAN IP known — replace the two example URLs with a generic
        # "your laptop's LAN IP" wording that doesn't carry a stale 10.0.0.9.
        base = (
            template
            .replace("http://{LAN_IP}:5173", "http://<your-laptop-lan-ip>:5173")
            .replace("{LAN_IP}", "<your-laptop-lan-ip>")
        )
    if model:
        friendly = _MODEL_DISPLAY.get(model, model)
        base += (
            f"\n\n===== CURRENT MODEL =====\n"
            f"You are running on {friendly} (model id: {model}) for THIS turn. "
            f"The user can swap models mid-conversation via the mobile UI, so the "
            f"prior assistant messages in this session's history may have come from "
            f"a different model. If asked what model you are, answer based on this "
            f"directive — '{friendly}' — not on whatever the prior turns said.\n"
            f"========================="
        )
    if permission_mode and permission_mode in _PERMISSION_MODE_DISPLAY:
        label, desc = _PERMISSION_MODE_DISPLAY[permission_mode]
        base += (
            f"\n\n===== CURRENT PERMISSION MODE =====\n"
            f"This turn is being processed in '{label}' (mode id: {permission_mode}). "
            f"{desc} "
            f"The user can switch modes between turns via the chip on the phone "
            f"compose row, so the prior assistant turns in this session may have "
            f"been processed in a different mode. If asked which permission mode "
            f"you are in, answer based on THIS directive — '{label}' — not on "
            f"whatever the prior turns said.\n"
            f"==================================="
        )
    base += _SELF_SCHEDULE_ADDENDUM
    return base


# Self-scheduling addendum — appended to every spawn's system prompt. Teaches
# Claude how to register OS-scheduler entries that POST to the bridge's
# /api/trigger/<token> endpoint for autonomous check-ins. The token itself is
# NOT in this string (it would leak to Anthropic via the prompt and persist in
# every jsonl) — Claude reads it from the file at runtime via Bash when
# actually wiring up a task.
_SELF_SCHEDULE_ADDENDUM = (
    "\n\n===== SELF-SCHEDULING (check yourself later via OS scheduler) =====\n"
    "If the user asks for periodic check-ins (\"check on this every 30 min\",\n"
    "\"keep an eye on X until it's done\", \"remind me at 3pm to look at Y\"),\n"
    "you can register an OS-scheduler entry that POSTs a fresh prompt back to\n"
    "the bridge. Each fire spawns a new claude-p run with a Web Push to the\n"
    "user's phone on completion.\n"
    "\n"
    "Endpoint (local-only):\n"
    "  POST http://localhost:8787/api/trigger/<TOKEN>\n"
    "Token file (single line, no quotes, no trailing newline):\n"
    "  <PROJECTS_ROOT>/.crc-trigger-token   (relative to cwd: ../.crc-trigger-token)\n"
    "  READ this with Bash when wiring up a task. DO NOT echo the token into\n"
    "  the chat or commit it anywhere — it is a shared secret.\n"
    "Body (JSON):\n"
    "  {\"project\": \"<name>\", \"prompt\": \"<what you want yourself to do>\",\n"
    "   \"label\": \"<short banner title>\", \"permission_mode\": \"auto|edits|plan|ask\"}\n"
    "  Defaults: permission_mode=auto. label defaults to project name.\n"
    "\n"
    "Tab continuation (important):\n"
    "  - Default behaviour: the fire CONTINUES the project's most recent\n"
    "    tab (resumes the same conversation). This is what the user wants\n"
    "    for status check-ins — you pick up where you left off instead\n"
    "    of starting a fresh chat each time.\n"
    "  - To FORK into a brand-new tab (e.g. one-off reminder, test ping),\n"
    "    add `\"force_new_tab\": true` to the body. The response includes\n"
    "    `resumed: true|false` so you can confirm.\n"
    "\n"
    "Windows (Task Scheduler — use this on this host):\n"
    "  $tok = Get-Content -Raw ..\\.crc-trigger-token\n"
    "  $body = '{\"project\":\"<P>\",\"prompt\":\"<TEXT>\",\"label\":\"<L>\"}'\n"
    "  schtasks /create /sc once /tn \"crc-<id>\" /st <HH:mm> /tr (\n"
    "    'powershell -NoProfile -WindowStyle Hidden -Command \"' +\n"
    "    'Invoke-RestMethod -Method Post -Uri http://localhost:8787/api/trigger/' +\n"
    "    $tok.Trim() + ' -ContentType application/json -Body ''' + $body + '''\"'\n"
    "  )\n"
    "Unix (cron):\n"
    "  TOK=$(cat ../.crc-trigger-token)\n"
    "  (crontab -l 2>/dev/null; echo \"*/30 * * * * curl -s -X POST \\\n"
    "    -H 'Content-Type: application/json' \\\n"
    "    -d '<json>' http://localhost:8787/api/trigger/$TOK\") | crontab -\n"
    "\n"
    "When the user asks for a recurring check-in:\n"
    "  1. Confirm exactly what you should ask yourself each fire.\n"
    "  2. Pick a stable task name (\"crc-check-<topic>\") so you can find and\n"
    "     delete it later. Tell the user the name.\n"
    "  3. Wire up the schedule via Bash with the OS-scheduler one-liner above.\n"
    "  4. Confirm it was created (schtasks /query /tn ... or crontab -l).\n"
    "  5. After the user's underlying task is done, REMOVE the schedule\n"
    "     (schtasks /delete /tn ... /F or crontab -l | grep -v ... | crontab -).\n"
    "     Otherwise it keeps firing — each fire is a real claude run that\n"
    "     costs money.\n"
    "\n"
    "Don't self-schedule for things the user can just ask you later. Use it\n"
    "for genuinely autonomous loops (long-running scrapes, training jobs,\n"
    "subagent batches the user is waiting on, lock-screen reminders).\n"
    "================================================================="
)

# asyncio.StreamReader's default line limit is 64 KiB. A single stream-json
# event can carry a tool_result blob (Read of a big file, Bash output, etc.)
# that easily exceeds that. We bump the buffer up so readline() doesn't bail
# with LimitOverrunError mid-run. 8 MiB is comfortable on a desktop.
_STREAM_LIMIT = 8 * 1024 * 1024


def _build_argv(claude_cmd: str, claude_args: list[str]) -> list[str]:
    """Resolve claude_cmd on this platform and wrap with cmd.exe if needed."""
    resolved = shutil.which(claude_cmd) or claude_cmd
    if sys.platform == "win32" and resolved.lower().endswith((".cmd", ".bat")):
        # /D disables AutoRun, /S simplifies cmd's quote stripping rules.
        return ["cmd.exe", "/D", "/S", "/C", resolved, *claude_args]
    return [resolved, *claude_args]


def build_claude_args(
    *,
    permission_mode: str,
    model: str,
    resume_session_id: str | None,
    effort: str | None = None,
    no_session_persistence: bool = False,
    lan_ip: str = "",
    agent: str | None = None,
) -> list[str]:
    """Build the argv tail for `claude -p <args>` based on settings.

    `resume_session_id` is claude's session UUID, captured from a previous
    run's `system.init` event. If set, the run is invoked with
    `--resume <id>` so it threads that exact conversation. If None, no
    resume flag is passed and claude creates a fresh session (with a new
    UUID we'll capture for next time).

    `effort` (low|medium|high|xhigh|max) maps to the CLI's `--effort` flag.
    None or "high" omits the flag (high is the documented default).

    `no_session_persistence=True` adds --no-session-persistence so this
    run's exchange is NOT saved to the project's conversation history on
    disk. Used by /ask so quick "is X in stock?" questions don't pollute
    the main tab's --resume context.
    """
    args = ["-p"]
    args.extend(_MODE_FLAGS.get(permission_mode, _MODE_FLAGS["auto"]))
    if effort and effort != "high" and effort in _VALID_EFFORTS:
        args.extend(["--effort", effort])
    args.extend(["--append-system-prompt", build_system_prompt(lan_ip, model, permission_mode)])
    args.extend([
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
    ])
    if resume_session_id:
        args.extend(["--resume", resume_session_id])
    if no_session_persistence:
        args.append("--no-session-persistence")
    if model:
        args.extend(["--model", model])
    if agent:
        args.extend(["--agent", agent])
    return args


async def spawn_claude(
    *,
    claude_cmd: str,
    cwd: Path,
    prompt: str,
    permission_mode: str,
    model: str,
    resume_session_id: str | None = None,
    on_text: OnText,
    on_tool_use: OnToolUse | None = None,
    on_tool_error: OnToolError | None = None,
    on_tool_result: OnToolResult | None = None,
    on_session_init: OnSessionInit | None = None,
    on_usage: OnUsage | None = None,
    effort: str | None = None,
    no_session_persistence: bool = False,
    lan_ip: str = "",
    agent: str | None = None,
) -> tuple[asyncio.subprocess.Process, asyncio.Task[int]]:
    """Spawn `claude -p` and start streaming its output.

    Returns the process handle and a background task that resolves with the
    exit code once the process finishes. Caller is responsible for awaiting
    the task (or terminating the process and then awaiting).
    """
    claude_args = build_claude_args(
        permission_mode=permission_mode,
        model=model,
        resume_session_id=resume_session_id,
        effort=effort,
        no_session_persistence=no_session_persistence,
        lan_ip=lan_ip,
        agent=agent,
    )
    argv = _build_argv(claude_cmd, claude_args)

    # Redact the system prompt body from the log line. Without redaction
    # the log accumulates kilobytes of guidance text per run AND prints
    # the auto-detected LAN IP that's substituted in. Neither is a hard
    # secret, but logs go to disk unencrypted and we'd rather keep them
    # tight + IP-free for users who share their bridge.log when filing
    # bugs.
    _safe_argv: list[str] = []
    _redact_next = False
    for _a in argv:
        if _redact_next:
            _safe_argv.append("<system-prompt-redacted>")
            _redact_next = False
        elif _a == "--append-system-prompt":
            _safe_argv.append(_a)
            _redact_next = True
        else:
            _safe_argv.append(_a)
    log.info("spawning: cwd=%s argv=%s", cwd, _safe_argv)

    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=_STREAM_LIMIT,
        env=_scrub_env(),
        creationflags=_NO_WINDOW,
    )

    # Feed the prompt over stdin and close it so claude sees EOF.
    if proc.stdin is not None:
        try:
            proc.stdin.write(prompt.encode("utf-8"))
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            log.warning("stdin write failed (process exited early?)")
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    # Drain stderr in the background. We don't surface it to the user — these
    # are verbose-mode diagnostics from claude itself, useful only for
    # debugging the bridge. If we left it un-drained the pipe could fill and
    # block claude's writes. We stash the task on the proc so the GC can't
    # collect it mid-run.
    proc._crc_stderr_task = asyncio.create_task(_drain_stderr(proc))  # type: ignore[attr-defined]

    task = asyncio.create_task(_pump_stream_json(
        proc, on_text, on_tool_use, on_tool_error, on_tool_result, on_session_init, on_usage,
    ))
    return proc, task


async def _drain_stderr(proc: asyncio.subprocess.Process) -> None:
    """Consume claude's stderr. Buffered as the last 32 lines on the process
    object so callers can surface a tail if the process exits non-zero. Logged
    at WARNING so failures (--resume conflicts, auth errors, etc.) actually
    appear in bridge.err.log without flipping the global log level."""
    if proc.stderr is None:
        return
    buf: deque[str] = deque(maxlen=32)
    try:
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            decoded = line.decode("utf-8", errors="replace").rstrip()
            if decoded:
                buf.append(decoded)
                log.warning("claude stderr: %s", decoded)
    except Exception:
        log.exception("stderr drainer failed; stopping")
    finally:
        proc._crc_stderr_tail = list(buf)  # type: ignore[attr-defined]


async def _pump_stream_json(
    proc: asyncio.subprocess.Process,
    on_text: OnText,
    on_tool_use: OnToolUse | None,
    on_tool_error: OnToolError | None,
    on_tool_result: OnToolResult | None,
    on_session_init: OnSessionInit | None,
    on_usage: OnUsage | None = None,
) -> int:
    """Read NDJSON stream-events from claude and forward to callbacks.

    Forwarded:
      - assistant text deltas → on_text (delta-by-delta, live "typing")
      - tool_use invocations  → on_tool_use (name + parsed input dict),
                                fired once per tool call when its input
                                JSON is fully accumulated
      - newline between successive text blocks so distinct sections of an
        assistant turn don't visually collide

    Suppressed (intentionally — the user wants the words claude writes, not
    raw output noise):
      - thinking blocks
      - tool_result content (raw bash output, file dumps, etc.)
      - system/init events and the final result summary

    Returns the process exit code.
    """
    assert proc.stdout is not None
    # Per-block state: type ("text"/"tool_use"/"thinking"), the tool name
    # if applicable, and accumulated input-JSON string for tool_use blocks
    # (since the JSON arrives in partial chunks via input_json_delta).
    block_types: dict[int, str] = {}
    block_tool_name: dict[int, str] = {}
    block_tool_input: dict[int, list[str]] = {}
    block_tool_id: dict[int, str] = {}
    block_emitted: set[int] = set()
    # Maps tool_use_id → tool name across the WHOLE run, so when a later
    # `user` event carries a tool_result block we can recognise which
    # tool emitted it. Without this, tool_error for AskUserQuestion (which
    # ALWAYS errors in `-p` mode because there is no answer round-trip)
    # would render as a red ⚠ card on top of the interactive ask card —
    # confusing noise the client cannot reliably suppress because of
    # PWA-cache race conditions and the askq card sometimes never
    # rendering (when input.questions arrives empty).
    tool_id_to_name: dict[str, str] = {}

    while True:
        try:
            line = await proc.stdout.readline()
        except asyncio.LimitOverrunError as e:
            log.warning("stream-json line exceeded %d bytes; dropping", _STREAM_LIMIT)
            try:
                await proc.stdout.readexactly(e.consumed)
            except (asyncio.IncompleteReadError, Exception):
                pass
            continue
        except Exception:
            log.exception("readline failed; stopping pump")
            break

        if not line:
            break

        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            log.debug("non-JSON line on stream: %r", line[:200])
            continue

        try:
            await _handle_event(
                event,
                block_types, block_emitted,
                block_tool_name, block_tool_input, block_tool_id,
                tool_id_to_name,
                on_text, on_tool_use, on_tool_error, on_tool_result, on_session_init, on_usage,
            )
        except Exception:
            log.exception("event handler raised; continuing")

    rc = await proc.wait()
    # Make sure the stderr drainer has finished writing its tail buffer
    # onto proc._crc_stderr_tail before the caller inspects it.
    stderr_task = getattr(proc, "_crc_stderr_task", None)
    if stderr_task is not None:
        try:
            await stderr_task
        except Exception:
            pass
    tail = getattr(proc, "_crc_stderr_tail", None) or []
    if rc != 0 and tail:
        log.warning("claude exited rc=%s; stderr tail: %s", rc, " | ".join(tail[-5:]))
    else:
        log.info("claude exited rc=%s", rc)
    return rc


async def _handle_event(
    event: dict,
    block_types: dict[int, str],
    block_emitted: set[int],
    block_tool_name: dict[int, str],
    block_tool_input: dict[int, list[str]],
    block_tool_id: dict[int, str],
    tool_id_to_name: dict[str, str],
    on_text: OnText,
    on_tool_use: OnToolUse | None,
    on_tool_error: OnToolError | None,
    on_tool_result: OnToolResult | None,
    on_session_init: OnSessionInit | None,
    on_usage: OnUsage | None = None,
) -> None:
    """Dispatch a single stream-json event. Mutates the block-state dicts."""
    ev_type = event.get("type")
    # `system.init` is the first event claude emits — it includes the
    # session UUID we need to capture so subsequent runs in this tab can
    # `--resume` the same conversation. Fires exactly once per run.
    if ev_type == "system" and event.get("subtype") == "init" and on_session_init is not None:
        try:
            await on_session_init(event)
        except Exception:
            log.exception("on_session_init raised; continuing")
        return
    # The terminal `result` event carries the final usage totals for the
    # run (input_tokens, output_tokens, cache_creation, cache_read). The
    # mobile client uses this to render a context-window donut next to
    # the mode chip. Top-level `assistant` events also carry per-message
    # usage; we forward those too so the donut updates mid-run as
    # claude does multi-turn tool work.
    if on_usage is not None:
        usage = None
        model_in_use = ""
        cost_usd = None
        if ev_type == "result":
            usage = event.get("usage")
            # Result events don't always carry a model field; fall back
            # silently if absent.
            model_in_use = event.get("model") or ""
            # total_cost_usd lives only on result events — capture so
            # `/cost` can surface the run's billed amount.
            c = event.get("total_cost_usd")
            if isinstance(c, (int, float)):
                cost_usd = float(c)
        elif ev_type == "assistant":
            msg = event.get("message") or {}
            usage = msg.get("usage")
            model_in_use = msg.get("model") or ""
        if isinstance(usage, dict):
            # Stash extras ON the usage dict so the existing OnUsage
            # callback signature can carry them through without plumbing
            # new parameters through 5 layers. The web sink picks these
            # up and forwards them to the mobile client. Keys are
            # leading-underscore so count_session_context's char-based
            # tokens math ignores them.
            extras: dict[str, Any] = {}
            if model_in_use and "_model" not in usage:
                extras["_model"] = model_in_use
            if cost_usd is not None:
                extras["_cost_usd"] = cost_usd
            if extras:
                usage = {**usage, **extras}
            try:
                await on_usage(usage)
            except Exception:
                log.exception("on_usage raised; continuing")
    # Tool results come back as top-level "user" messages with content
    # entries of type "tool_result". Two paths:
    #   - is_error=True  → also fire on_tool_error so the UI can show a
    #                      red ⚠ card explaining WHY the tool failed.
    #   - either case   → fire on_tool_result with tool_use_id + text so
    #                      the matching tool-use card can show its OUT.
    if ev_type == "user":
        msg = event.get("message") or {}
        for block in (msg.get("content") or []):
            if block.get("type") != "tool_result":
                continue
            content = block.get("content")
            if isinstance(content, list):
                parts = [c.get("text", "") for c in content if isinstance(c, dict)]
                text = "\n".join(p for p in parts if p)
            elif isinstance(content, str):
                text = content
            else:
                text = ""
            is_error = bool(block.get("is_error"))
            tool_use_id = block.get("tool_use_id") or ""
            # AskUserQuestion ALWAYS errors in `-p` mode because the
            # tool requires an interactive answer round-trip that
            # headless claude can't provide. The interactive card
            # rendered on the client IS the answer path; the
            # model-layer error is internal plumbing the user must
            # never see. Suppress both tool_error AND tool_result for
            # this case so a stale or never-rendered askq DOM can't
            # leak the red ⚠ card.
            originating_tool = tool_id_to_name.get(tool_use_id, "")
            if originating_tool == "AskUserQuestion":
                continue
            if is_error and text and on_tool_error is not None:
                try:
                    await on_tool_error(text, tool_use_id)
                except Exception:
                    log.exception("on_tool_error raised; continuing")
            if on_tool_result is not None and (text or is_error):
                try:
                    await on_tool_result(tool_use_id, text, is_error)
                except Exception:
                    log.exception("on_tool_result raised; continuing")
        return

    if ev_type != "stream_event":
        return

    inner = event.get("event") or {}
    it = inner.get("type")

    if it == "message_start":
        block_types.clear()
        block_emitted.clear()
        block_tool_name.clear()
        block_tool_input.clear()
        return

    if it == "content_block_start":
        idx = inner.get("index", 0)
        block = inner.get("content_block") or {}
        btype = block.get("type", "")
        block_types[idx] = btype
        if btype == "tool_use":
            block_tool_name[idx] = block.get("name", "")
            block_tool_input[idx] = []
            # Capture tool_use id (e.g. "toolu_01...") so we can pair it
            # with its matching tool_result event later (mobile renders
            # IN/OUT card pairs by this id).
            block_tool_id[idx] = block.get("id") or ""
        return

    if it == "content_block_delta":
        idx = inner.get("index", 0)
        btype = block_types.get(idx)
        delta = inner.get("delta") or {}
        dtype = delta.get("type")
        if btype == "text" and dtype == "text_delta":
            text = delta.get("text") or ""
            if text:
                await on_text(text)
                block_emitted.add(idx)
        elif btype == "tool_use" and dtype == "input_json_delta":
            # Tool input arrives in JSON-string chunks; accumulate and parse
            # at content_block_stop, when the full input is in hand.
            partial = delta.get("partial_json") or ""
            if partial and idx in block_tool_input:
                block_tool_input[idx].append(partial)
        return

    if it == "content_block_stop":
        idx = inner.get("index", 0)
        btype = block_types.get(idx)
        if btype == "text" and idx in block_emitted:
            await on_text("\n")
        elif btype == "tool_use" and on_tool_use is not None:
            name = block_tool_name.get(idx, "")
            raw = "".join(block_tool_input.get(idx, []))
            input_data: dict = {}
            try:
                if raw:
                    input_data = json.loads(raw)
            except json.JSONDecodeError:
                log.debug("tool_use input not valid JSON: %r", raw[:200])
            tool_use_id = block_tool_id.get(idx, "")
            if name:
                if tool_use_id:
                    tool_id_to_name[tool_use_id] = name
                try:
                    await on_tool_use(name, input_data, tool_use_id)
                except Exception:
                    log.exception("on_tool_use raised; continuing")
        return


async def terminate(proc: asyncio.subprocess.Process, grace_seconds: float = 3.0) -> None:
    """Stop a running claude process: terminate, wait briefly, then kill.

    On Windows, `claude` is a `.cmd` shim that we wrap with `cmd.exe /C` —
    so `proc.terminate()` would only kill cmd.exe, leaving the actual
    node.exe child running indefinitely. The fix is `taskkill /F /T`,
    which walks the process tree and forcibly kills every descendant.
    """
    if proc.returncode is not None:
        return
    if sys.platform == "win32":
        try:
            killer = await asyncio.create_subprocess_exec(
                "taskkill", "/F", "/T", "/PID", str(proc.pid),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=_NO_WINDOW,
            )
            await asyncio.wait_for(killer.wait(), timeout=5.0)
        except (FileNotFoundError, asyncio.TimeoutError, OSError):
            # taskkill missing / hung — fall through to proc.kill() below.
            try:
                proc.kill()
            except ProcessLookupError:
                return
    else:
        try:
            proc.terminate()
        except ProcessLookupError:
            return
    try:
        await asyncio.wait_for(proc.wait(), timeout=grace_seconds)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=grace_seconds)
        except asyncio.TimeoutError:
            log.error("claude pid=%s refused to die", proc.pid)
