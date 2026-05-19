"""Per-tab session lifecycle.

A "session" used to mean "one conversation per project". With multi-tab
on the web UI a project can have many parallel conversations open, so
the record is now keyed by `tab_id` — an opaque string the caller
generates (the web client uses 16-char base36 IDs).

Output goes to a `RunSink` — currently `WebSink` is the only implementation,
but the protocol is kept abstract so future transports can be added without
touching SessionManager.

Concurrency: tabs in the same project CAN run in parallel — the user
opted into that explicitly when asking for multi-tab. Total parallelism
is still capped by `cfg.max_concurrent_runs` via a shared semaphore so a
runaway client can't fork-bomb the laptop.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from . import runner, watcher
from .config import Config
from .jsonl_helpers import count_session_context
from .sink import RunSink
from .state import BridgeState

log = logging.getLogger(__name__)

# Image extensions claude might Read/Write that we want to auto-attach to
# the phone chat as inline tappable tiles. Keep this conservative — we'd
# rather miss an exotic format than push a huge proprietary file.
_INLINE_IMAGE_EXTS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico",
})


async def _maybe_send_inline_media(
    name: str,
    input_data: dict,
    project: str,
    cwd: Path,
    sink: RunSink,
) -> None:
    """When claude reads (or writes) an image file inside the project's
    cwd, push it to the phone as an inline `media` tile in addition to
    the tool_use card. The tile renders the actual image and is tappable
    for the full-size lightbox. Without this, the user only sees that
    claude touched the file — they can't see what's IN it without
    leaving the chat.

    Currently image-only. CSV / other openable files are a future
    extension (they'd render as download tiles instead)."""
    if name not in ("Read", "Write"):
        return
    file_path = input_data.get("file_path") or input_data.get("path")
    if not isinstance(file_path, str) or not file_path:
        return
    ext = Path(file_path).suffix.lower()
    if ext not in _INLINE_IMAGE_EXTS:
        return
    try:
        p = Path(file_path)
        if not p.is_absolute():
            p = (cwd / file_path).resolve()
        else:
            p = p.resolve()
        # Path jail: never leak files outside the active project's cwd.
        p.relative_to(cwd.resolve())
    except (OSError, ValueError):
        return
    if not p.is_file():
        return
    # Skip files inside `.web-uploads/` — these are user-supplied
    # attachments. The user already sees them as a chip on their own
    # message bubble (via the replay's attachment extractor), so
    # re-pushing them as a separate inline media tile under claude's
    # response makes the same image appear twice. The intent of
    # `_maybe_send_inline_media` is to surface PROJECT files claude
    # reads, not echo back uploads.
    try:
        parts = p.relative_to(cwd.resolve()).parts
        if parts and parts[0] == ".web-uploads":
            return
    except ValueError:
        pass
    try:
        await sink.send_media(p, tag=project)
    except Exception:
        log.exception("inline media send failed for %s", p)


@dataclass
class Session:
    """One tab's conversation state."""
    tab_id: str
    project: str
    cwd: Path
    # claude's session UUID, captured from the `system.init` event of the
    # first run in this tab. None until the first run completes its init.
    # Subsequent runs pass `--resume <session_id>` to thread the conversation.
    session_id: str | None = None
    current: "ActiveRun | None" = None
    next_run_id: int = 1


@dataclass
class ActiveRun:
    proc: asyncio.subprocess.Process
    output_task: asyncio.Task[int]
    watcher_task: asyncio.Task[None] | None
    started_at: float
    run_id: int
    sink: RunSink


@dataclass
class AdhocRun:
    """Side-channel claude run started by /ask. Bypasses the per-tab session
    queue so quick questions can run alongside a long-running main session,
    and uses `--no-session-persistence` so the exchange doesn't pollute the
    main session's conversation history on disk."""
    proc: asyncio.subprocess.Process
    output_task: asyncio.Task[int]
    started_at: float
    run_id: int
    tab_id: str
    project: str
    sink: RunSink


class SessionManager:
    def __init__(self, cfg: Config, state: BridgeState) -> None:
        self.cfg = cfg
        self.state = state
        # Sessions keyed by tab_id (16-char base36 from the web client).
        self.sessions: dict[str, Session] = {}
        # Adhoc IDs start at 1_000_000 so they can't collide with main-session
        # run_ids (which start at 1 and increment per tab).
        self.adhoc_runs: dict[int, AdhocRun] = {}
        self.next_adhoc_id: int = 1_000_000
        # Cap total concurrent `claude -p` subprocesses so a runaway client
        # (or many parallel tabs) can't fork-bomb the laptop.
        self._run_semaphore = asyncio.Semaphore(cfg.max_concurrent_runs)

    def get(self, tab_id: str, project: str, cwd: Path) -> Session:
        sess = self.sessions.get(tab_id)
        if sess is None:
            sess = Session(tab_id=tab_id, project=project, cwd=cwd)
            self.sessions[tab_id] = sess
        return sess

    def is_busy(self, tab_id: str) -> bool:
        sess = self.sessions.get(tab_id)
        return bool(sess and sess.current is not None)

    def list_running(self) -> list[tuple[str, str, float]]:
        """List of (tab_id, project, started_at) for every active run.
        Includes both main runs and adhoc /ask runs."""
        out: list[tuple[str, str, float]] = [
            (s.tab_id, s.project, s.current.started_at)
            for s in self.sessions.values()
            if s.current is not None
        ]
        for adhoc in self.adhoc_runs.values():
            out.append((adhoc.tab_id, f"{adhoc.project} (ask)", adhoc.started_at))
        return out

    async def reset(self, tab_id: str) -> None:
        """`/new` — drop the captured claude session_id so the next run starts
        a fresh conversation. Does not stop a currently-active run."""
        async with self.state.project_lock(tab_id):
            sess = self.sessions.get(tab_id)
            if sess:
                # Drop the paused-session marker for the OLD session_id
                # before clearing it — otherwise the (project, old_sid)
                # pair would sit in state.paused_sessions until bridge
                # restart, and any future /messages poll for the old
                # session would return paused:true forever. Security
                # audit 2026-05-15 flagged this as a Low cosmetic bug.
                if sess.project and sess.session_id:
                    self.state.paused_sessions.discard((sess.project, sess.session_id))
                sess.session_id = None

    async def _stop_active(self, tab_id: str, expected_run_id: int | None = None) -> bool:
        """Terminate this tab's active run under one lock acquisition.

        If `expected_run_id` is given, only stop if it matches — used by the
        `🛑 Stop` button which carries a specific run_id and shouldn't
        accidentally kill a *different* run that started in between the user
        tapping the button and the callback arriving."""
        async with self.state.project_lock(tab_id):
            sess = self.sessions.get(tab_id)
            if not sess or sess.current is None:
                return False
            if expected_run_id is not None and sess.current.run_id != expected_run_id:
                return False
            run = sess.current
            await runner.terminate(run.proc)
            try:
                await asyncio.wait_for(run.output_task, timeout=3.0)
            except asyncio.TimeoutError:
                run.output_task.cancel()
                # Wait briefly for the cancellation to propagate so the
                # pump task releases the subprocess stdout pipe before
                # the next --resume on this session opens it again.
                # Without this `await`, the pump can sit in a zombie
                # state until the next GC cycle.
                try:
                    await asyncio.wait_for(run.output_task, timeout=1.0)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pass
            if run.watcher_task is not None:
                run.watcher_task.cancel()
            sess.current = None
            return True

    async def stop(self, tab_id: str) -> bool:
        """Stop the current run for this tab. Returns True if something was stopped.

        Also marks the underlying (project, session_id) pair as paused
        so a subsequent close+reopen of the tab cannot resume by
        replaying buffered jsonl events or by mirroring a parallel
        VS Code claude run on the same session. The pause is cleared
        when the user sends a fresh prompt — that act IS the resume.
        """
        sess = self.sessions.get(tab_id)
        if sess and sess.project and sess.session_id:
            self.state.paused_sessions.add((sess.project, sess.session_id))
        return await self._stop_active(tab_id)

    async def stop_run(self, tab_id: str, run_id: int) -> bool:
        """Stop a specific run by id (main or adhoc /ask)."""
        adhoc = self.adhoc_runs.get(run_id)
        if adhoc is not None and adhoc.tab_id == tab_id:
            await runner.terminate(adhoc.proc)
            try:
                await asyncio.wait_for(adhoc.output_task, timeout=3.0)
            except asyncio.TimeoutError:
                adhoc.output_task.cancel()
                # Same rationale as _stop_active above — give the
                # cancellation a chance to propagate so the stdout pipe
                # is released cleanly.
                try:
                    await asyncio.wait_for(adhoc.output_task, timeout=1.0)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pass
            self.adhoc_runs.pop(run_id, None)
            return True
        return await self._stop_active(tab_id, expected_run_id=run_id)

    async def stop_all(self) -> None:
        """Stop every running session AND every adhoc /ask run. Called on
        bridge shutdown."""
        for run_id in list(self.adhoc_runs.keys()):
            adhoc = self.adhoc_runs.get(run_id)
            if adhoc is None:
                continue
            try:
                await runner.terminate(adhoc.proc)
            except Exception:
                log.exception("failed to terminate adhoc run %s", run_id)
            # Await the adhoc's output task with a short timeout so the
            # stdout pump finishes cleanly. Otherwise asyncio.run() cancels
            # it mid-read on shutdown and an unhandled CancelledError
            # surfaces in the logs.
            try:
                await asyncio.wait_for(adhoc.output_task, timeout=3.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                adhoc.output_task.cancel()
            except Exception:
                log.exception("adhoc output_task await raised on shutdown")
        await asyncio.gather(
            *(self.stop(tid) for tid in list(self.sessions)),
            return_exceptions=True,
        )

    async def remove(self, tab_id: str) -> None:
        """Drop the session record for this tab. If a run is still active,
        stop it first. Used when the user closes a tab in the web UI."""
        await self._stop_active(tab_id)
        self.sessions.pop(tab_id, None)

    async def run(
        self,
        *,
        tab_id: str,
        project: str,
        cwd: Path,
        prompt: str,
        permission_mode: str,
        sink: RunSink,
        effort: str | None = None,
        cleanup_paths: list[Path] | None = None,
        force_session_id: str | None = None,
        model_override: str | None = None,
        no_session_persistence: bool = False,
        agent: str | None = None,
    ) -> None:
        """Run `claude -p` for this project, streaming output to `sink`.

        If a run is already in progress for this project, send a "busy" message
        via the sink and return without starting another one.

        `cleanup_paths` is a list of files to delete after the run finishes
        (whether it succeeded, was rejected as busy, or errored). Used by
        image-upload handlers to keep ephemeral inputs from piling up.

        `model_override` (e.g. "claude-opus-4-7") takes precedence over the
        server's CLAUDE_MODEL config for THIS run only. The next run on the
        same tab can use a different model — claude.exe handles the swap by
        --resuming the same session and reading prior turns from the jsonl.

        `no_session_persistence=True` adds --no-session-persistence to the
        claude argv so this run reads the existing session as context but
        does NOT fork into a fresh jsonl. Used by auto-compact: the
        compact run produces the summary via the model, but doesn't
        write a new session file — the subsequent compact_inplace
        endpoint appends the boundary + summary into the ORIGINAL
        session's jsonl, keeping the user's chat in the same session.
        """
        cleanup_paths = list(cleanup_paths or [])
        try:
            await self._run_inner(
                tab_id=tab_id, project=project, cwd=cwd, prompt=prompt,
                permission_mode=permission_mode, sink=sink, effort=effort,
                force_session_id=force_session_id,
                model_override=model_override,
                no_session_persistence=no_session_persistence,
                agent=agent,
            )
        finally:
            for p in cleanup_paths:
                try:
                    p.unlink(missing_ok=True)
                except OSError:
                    log.warning("failed to clean up temp file %s", p)

    async def _run_inner(
        self,
        *,
        tab_id: str,
        project: str,
        cwd: Path,
        prompt: str,
        permission_mode: str,
        sink: RunSink,
        effort: str | None = None,
        force_session_id: str | None = None,
        model_override: str | None = None,
        no_session_persistence: bool = False,
        agent: str | None = None,
    ) -> None:
        async with self.state.project_lock(tab_id):
            sess = self.get(tab_id, project, cwd)
            if sess.current is not None:
                age = time.time() - sess.current.started_at
                await sink.send_text(
                    f"Tab busy ({age:.0f}s in). Wait, or stop this tab to interrupt.",
                    tag=project,
                )
                return
            # If the caller explicitly hands us a session id (e.g. "resume
            # this past Claude session in a new tab" from the history panel),
            # adopt it BEFORE the run so --resume <id> picks up the right
            # conversation on disk. Otherwise use whatever we captured from
            # a previous run in this tab.
            if force_session_id is not None:
                sess.session_id = force_session_id
            resume_id = sess.session_id
            run_id = sess.next_run_id
            sess.next_run_id += 1

        # run_started before holding the lock again — the sink may make
        # slow network calls (WebSocket send to a backgrounded phone, for
        # instance) and we don't want to gate other ops on it.
        await sink.run_started(project=project, run_id=run_id)

        # Block here if we're already at the global subprocess ceiling.
        # Only surface the "waiting" hint if the acquire actually takes
        # more than half a second — without that delay we'd flash the
        # message on every run thanks to the locked() pre-check's
        # TOCTOU race (the slot can free up between the check and the
        # acquire, and the user sees a spurious "another project is
        # busy" message even though they were never blocked).
        _slot_waiter = asyncio.create_task(self._run_semaphore.acquire())
        try:
            try:
                await asyncio.wait_for(asyncio.shield(_slot_waiter), timeout=0.5)
            except asyncio.TimeoutError:
                await sink.send_text(
                    "(waiting for a free run slot — another project is busy)",
                    tag=project,
                )
                await _slot_waiter
        except BaseException:
            # If we get cancelled (or anything else propagates) before
            # we own the slot, drain the orphan acquire task so it can't
            # silently consume a permit in the background. Without this
            # the semaphore leaks one permit per cancelled run, and
            # eventually no new runs can start. If the cancel raced
            # with the acquire (permit ended up held), release it.
            _slot_waiter.cancel()
            try:
                await _slot_waiter
            except BaseException:
                # CancelledError (cancel won) or any other; either way
                # no permit was held → nothing to release.
                pass
            else:
                self._run_semaphore.release()
            raise
        try:
            # Track whether claude got far enough to emit system.init.
            # If we asked for --resume <id> and rc != 0 with NO init seen,
            # the overwhelmingly likely cause is another claude.exe (eg.
            # VSCode's) holding an exclusive lock on the session jsonl —
            # claude.exe bails silently in that case (no stderr output).
            saw_init = False
            async with self.state.project_lock(tab_id):
                sess = self.get(tab_id, project, cwd)
                # Capture claude's session UUID from the system.init event of
                # this run, so subsequent runs in this tab can --resume it.
                # Preserve the original session_id across --no-session-
                # persistence runs (auto-compact). claude.exe still emits
                # system.init with a fresh ephemeral session_id, but
                # adopting that would point future --resume calls at
                # a jsonl claude never wrote to disk. Keep the prior
                # sess.session_id and DON'T forward the ephemeral one
                # to the client either, so tab.sessionId stays anchored
                # to the actual conversation jsonl on disk.
                preserved_session_id = sess.session_id if no_session_persistence else None
                async def _on_init(init: dict) -> None:
                    nonlocal saw_init
                    saw_init = True
                    sid = init.get("session_id")
                    if sid:
                        if no_session_persistence:
                            # Discard the ephemeral session_id; keep the
                            # original so the next prompt --resumes the
                            # right jsonl. Don't emit session_init to
                            # the client either — its tab.sessionId
                            # must not get overwritten.
                            sess.session_id = preserved_session_id
                            return
                        sess.session_id = sid
                        try:
                            await sink.emit_session_init(session_id=sid)
                        except Exception:
                            log.exception("sink.emit_session_init raised")
                async def _on_usage(u: dict) -> None:
                    # Compute a session-wide context-tokens approximation
                    # by walking the session's jsonl on disk. This is
                    # what the mobile donut shows — it has to match what
                    # VSCode's `/context` reports, and that's the
                    # cumulative tokenized content of the conversation,
                    # NOT a sum of per-API-call usage numbers (which
                    # double-count cached content).
                    ctx_used = 0
                    if sess.session_id:
                        try:
                            # Off the event loop — count_session_context
                            # walks the full jsonl synchronously, which
                            # can be tens of ms on long sessions and
                            # introduces visible jitter in the streaming
                            # deltas if it runs inline.
                            ctx_used = await asyncio.to_thread(
                                count_session_context, sess.session_id, sess.cwd,
                            )
                        except Exception:
                            log.exception("count_session_context raised")
                    try:
                        await sink.emit_usage(
                            input_tokens=int(u.get("input_tokens", 0) or 0),
                            output_tokens=int(u.get("output_tokens", 0) or 0),
                            cache_read_tokens=int(u.get("cache_read_input_tokens", 0) or 0),
                            cache_creation_tokens=int(u.get("cache_creation_input_tokens", 0) or 0),
                            context_used=ctx_used,
                            model=u.get("_model") or "",
                            cost_usd=u.get("_cost_usd"),
                        )
                    except Exception:
                        log.exception("sink.emit_usage raised")
                # When True, the outcome handler below uses
                # outcome="awaiting_user" instead of "error" so the
                # client doesn't render a red "rc=1" pill on a run
                # that intentionally stopped to wait for the user's
                # answer.
                terminated_for_askq = [False]
                async def _on_tool_use(n: str, d: dict, tid: str) -> None:
                    await sink.emit_tool_use(name=n, input_data=d, tool_use_id=tid)
                    await _maybe_send_inline_media(n, d, project, cwd, sink)
                    # AskUserQuestion in `-p` mode has no answer
                    # round-trip — claude.exe gets a synthetic
                    # is_error=true tool_result back and ALWAYS
                    # follows up with text rationalising the "card
                    # dismissed" outcome before the user has even
                    # read the questions. Terminate the subprocess
                    # the instant the tool_use is fully serialised so
                    # the rationalising text never makes it out. The
                    # user's eventual answer (submitted via the
                    # interactive card) lands as a fresh prompt with
                    # `--continue`, so the conversation continues
                    # cleanly with claude's first response BEING the
                    # one written from the answer it actually saw.
                    if n == "AskUserQuestion":
                        current = sess.current
                        if current is not None and current.proc is not None:
                            log.info(
                                "terminating claude after AskUserQuestion so it can't write a 'card dismissed' follow-up",
                            )
                            terminated_for_askq[0] = True
                            try:
                                await runner.terminate(current.proc, grace_seconds=1.0)
                            except Exception:
                                log.exception("post-AskUserQuestion terminate failed; continuing")
                try:
                    proc, output_task = await runner.spawn_claude(
                        claude_cmd=self.cfg.claude_cmd,
                        cwd=cwd,
                        prompt=prompt,
                        permission_mode=permission_mode,
                        model=model_override or self.cfg.claude_model,
                        resume_session_id=resume_id,
                        on_text=sink.emit_delta,
                        on_tool_use=_on_tool_use,
                        on_tool_error=lambda t, tid: sink.emit_tool_error(text=t, tool_use_id=tid),
                        on_tool_result=lambda tid, t, err: sink.emit_tool_result(tool_use_id=tid, text=t, is_error=err),
                        on_session_init=_on_init,
                        on_usage=_on_usage,
                        effort=effort,
                        lan_ip=self.cfg.lan_ip,
                        no_session_persistence=no_session_persistence,
                        agent=agent,
                    )
                except FileNotFoundError as e:
                    await sink.emit_final()
                    await sink.run_finished(
                        project=project, run_id=run_id,
                        outcome="error", detail=f"launch failed: {e}",
                    )
                    await sink.send_text(
                        f"Couldn't launch claude: {e}. Check CLAUDE_CMD in .env.local.",
                        tag=project,
                    )
                    return
                watcher_task = asyncio.create_task(
                    watcher.watch_project(
                        cwd=cwd,
                        folders=self.cfg.watch_folders,
                        on_file=self._make_file_handler(sink, project),
                    )
                )
                sess.current = ActiveRun(
                    proc=proc,
                    output_task=output_task,
                    watcher_task=watcher_task,
                    started_at=time.time(),
                    run_id=run_id,
                    sink=sink,
                )

            # Wait for the run to finish OUTSIDE the lock so other ops on this
            # project (like /stop, /sessions) can interleave.
            rc = -1
            was_cancelled = False
            try:
                rc = await output_task
            except asyncio.CancelledError:
                was_cancelled = True
                log.info("output task cancelled for %s", project)
            finally:
                # Drain the sink's buffer first so any trailing partial text
                # reaches the user BEFORE the "done" indicator lands.
                try:
                    await sink.emit_final()
                except Exception:
                    log.exception("sink.emit_final raised")
                async with self.state.project_lock(tab_id):
                    sess = self.sessions.get(tab_id)
                    if sess is not None and sess.current is not None and sess.current.run_id == run_id:
                        if sess.current.watcher_task is not None:
                            sess.current.watcher_task.cancel()
                        sess.current = None
                        # sess.session_id was set during the run by _on_init —
                        # subsequent runs in this tab will --resume it.

            if was_cancelled:
                outcome, detail = "stopped", ""
            elif terminated_for_askq[0]:
                # Bridge terminated claude on purpose after an
                # AskUserQuestion call (so it can't write a follow-up
                # text before the user answers). Don't treat that
                # as a run failure — surface it as a "done" so the
                # red "rc=1" error pill never renders. The askq card
                # itself is the user-facing affordance to continue.
                outcome, detail = "done", ""
            elif rc == 0:
                outcome, detail = "done", ""
            else:
                tail = getattr(proc, "_crc_stderr_tail", None) or []
                tail_text = " | ".join(tail[-3:])[:500]
                outcome = "error"
                # Concurrent-session-lock case: we asked for --resume on
                # an existing session, claude.exe never emitted init, and
                # exited non-zero — almost certainly another claude.exe
                # (eg. VSCode's interactive session) holds the jsonl.
                if resume_id and not saw_init:
                    detail = (
                        f"This session is in use by another Claude Code "
                        f"window (most likely VSCode). The bridge can't "
                        f"share an active session — close it in VSCode, "
                        f"or tap + to start a new tab here."
                    )
                elif tail_text:
                    detail = f"rc={rc}: {tail_text}"
                else:
                    detail = f"rc={rc}"
            await sink.run_finished(
                project=project, run_id=run_id, outcome=outcome, detail=detail,
                notify=not no_session_persistence,
            )
        finally:
            self._run_semaphore.release()

    async def ask(
        self,
        *,
        tab_id: str,
        project: str,
        cwd: Path,
        prompt: str,
        permission_mode: str,
        sink: RunSink,
        effort: str | None = None,
    ) -> None:
        """Side-channel quick-question run, doesn't block the tab's main run.
        Resumes the same conversation if the tab has a captured session_id,
        plus `--no-session-persistence` so this exchange doesn't get saved
        and pollute future `--resume` runs."""
        run_id = self.next_adhoc_id
        self.next_adhoc_id += 1

        sess = self.sessions.get(tab_id)
        resume_id = sess.session_id if sess else None

        await sink.run_started(project=project, run_id=run_id)

        async def _on_usage_adhoc(u: dict) -> None:
            ctx_used = 0
            if sess and sess.session_id:
                try:
                    ctx_used = await asyncio.to_thread(
                        count_session_context, sess.session_id, sess.cwd,
                    )
                except Exception:
                    log.exception("count_session_context raised (adhoc)")
            try:
                await sink.emit_usage(
                    input_tokens=int(u.get("input_tokens", 0) or 0),
                    output_tokens=int(u.get("output_tokens", 0) or 0),
                    cache_read_tokens=int(u.get("cache_read_input_tokens", 0) or 0),
                    cache_creation_tokens=int(u.get("cache_creation_input_tokens", 0) or 0),
                    context_used=ctx_used,
                )
            except Exception:
                log.exception("sink.emit_usage raised (adhoc)")
        await self._run_semaphore.acquire()
        try:
            async def _on_tool_use_adhoc(n: str, d: dict, tid: str) -> None:
                await sink.emit_tool_use(name=n, input_data=d, tool_use_id=tid)
                await _maybe_send_inline_media(n, d, project, cwd, sink)
            try:
                proc, output_task = await runner.spawn_claude(
                    claude_cmd=self.cfg.claude_cmd,
                    cwd=cwd,
                    prompt=prompt,
                    permission_mode=permission_mode,
                    model=self.cfg.claude_model,
                    resume_session_id=resume_id,
                    on_text=sink.emit_delta,
                    on_tool_use=_on_tool_use_adhoc,
                    on_tool_error=lambda t, tid: sink.emit_tool_error(text=t, tool_use_id=tid),
                    on_tool_result=lambda tid, t, err: sink.emit_tool_result(tool_use_id=tid, text=t, is_error=err),
                    on_usage=_on_usage_adhoc,
                    effort=effort,
                    no_session_persistence=True,
                    lan_ip=self.cfg.lan_ip,
                )
            except FileNotFoundError as e:
                await sink.emit_final()
                await sink.run_finished(
                    project=project, run_id=run_id,
                    outcome="error", detail=f"launch failed: {e}",
                )
                await sink.send_text(
                    f"Couldn't launch claude: {e}. Check CLAUDE_CMD in .env.local.",
                    tag=project,
                )
                return

            adhoc = AdhocRun(
                proc=proc, output_task=output_task,
                started_at=time.time(), run_id=run_id,
                tab_id=tab_id, project=project, sink=sink,
            )
            self.adhoc_runs[run_id] = adhoc

            rc = -1
            was_cancelled = False
            try:
                rc = await output_task
            except asyncio.CancelledError:
                was_cancelled = True
                log.info("adhoc output task cancelled for %s run_id=%s", project, run_id)
            finally:
                try:
                    await sink.emit_final()
                except Exception:
                    log.exception("sink.emit_final raised on adhoc")
                self.adhoc_runs.pop(run_id, None)

            if was_cancelled:
                outcome, detail = "stopped", ""
            elif rc == 0:
                outcome, detail = "done", ""
            else:
                # Surface the last ~3 stderr lines so the user understands
                # WHY the run failed (--resume conflict, auth error, etc.)
                # instead of just a numeric exit code.
                tail = getattr(proc, "_crc_stderr_tail", None) or []
                tail_text = " | ".join(tail[-3:])[:500]
                outcome = "error"
                detail = f"rc={rc}: {tail_text}" if tail_text else f"rc={rc}"
            # /ask is a side-channel quick question the user is actively
            # watching, AND it uses --no-session-persistence. Either way the
            # phone shouldn't get a push notification for it.
            await sink.run_finished(
                project=project, run_id=run_id, outcome=outcome, detail=detail,
                notify=False,
            )
        finally:
            self._run_semaphore.release()

    def _make_file_handler(self, sink: RunSink, project: str) -> Callable[[Path], Awaitable[None]]:
        async def handle(path: Path) -> None:
            try:
                await sink.send_media(path, tag=project)
            except Exception:
                log.exception("sink.send_media raised for %s", path)
        return handle
