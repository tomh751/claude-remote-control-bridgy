"""RunSink implementation that forwards events to a WebSocket client.

The PWA renders incoming text into the active assistant bubble character
by character so live typing is the desired UX — deltas are forwarded raw
with no batching or message-length cap.

One sink per (WebSocket connection, claude run). The sink doesn't own
the connection; the server hands it the connection's send queue. If the
queue is full or closed the sink drops the event silently — the user just
sees a gap in output, which they can recover from by reconnecting.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from .protocol import msg

log = logging.getLogger(__name__)


class WebSink:
    """RunSink that emits JSON events into an asyncio.Queue drained by the
    WebSocket sender task."""

    def __init__(
        self,
        outbound: asyncio.Queue[dict[str, Any]],
        *,
        tab_id: str,
        max_media_mb: int,
        media_url_for: "MediaUrlFn",
        push_notify=None,
    ) -> None:
        """
        tab_id          — which client tab this sink belongs to. Every frame
                          this sink emits carries this id so the client can
                          route the event to the correct tab's chat DOM.
        outbound        — queue the server reads to push frames to the WS.
        max_media_mb    — skip files larger than this.
        media_url_for   — fn(Path) → str, returns a URL the client can GET to
                          download the file. The server registers a download
                          token for the path and returns /media/<token>.
        push_notify     — async callable invoked once per `run_finished` event
                          to fan out Web Push notifications to subscribed
                          phones. Called only on real completions (not
                          stopped / errored runs). Signature:
                              await push_notify(
                                  project: str, outcome: str,
                                  tab_id: str, summary: str,
                                  session_id: str,
                              )
                          The tab_id and session_id are embedded in the
                          deep-link URL so a tap on the banner resumes the
                          exact tab / session that finished, even hours
                          later when the originating tab may have closed.
                          Optional — if None, no pushes are sent.
        """
        self._out = outbound
        self._tab_id = tab_id
        self._max_media_mb = max_media_mb
        self._media_url_for = media_url_for
        self._push_notify = push_notify
        self._project: str | None = None
        self._run_id: int | None = None
        # Claude's session UUID for this run, captured from emit_session_init.
        # Threaded into push notifications so a tap on an old banner can
        # resume the EXACT session, even if the originating tab has been
        # closed locally (which is what happens to multi-hour-old banners).
        self._session_id: str | None = None
        # Tail of the last text block the assistant emitted. We snapshot
        # this into the push body so the lock-screen banner shows what
        # Claude actually said — "Bridge restarted on PID 44860" beats
        # "Run done in bridgy" by miles when the user has
        # five tabs in flight.
        self._last_text_buf: str = ""

    async def _put(self, frame: dict[str, Any]) -> None:
        # Stamp every frame with our tab_id so the client routes the event to
        # the right tab's chat. Without this, frames for tab A could render
        # in tab B's chat if both happened to be active simultaneously in
        # different projects.
        frame.setdefault("tab_id", self._tab_id)
        try:
            self._out.put_nowait(frame)
        except asyncio.QueueFull:
            log.warning("WS outbound queue full; dropping frame type=%s", frame.get("type"))

    # ── RunSink protocol ─────────────────────────────────────────────────

    async def run_started(self, *, project: str, run_id: int) -> None:
        self._project = project
        self._run_id = run_id
        self._last_text_buf = ""
        await self._put(msg("run_started", project=project, run_id=run_id))

    async def emit_delta(self, text: str) -> None:
        if not text:
            return
        # Accumulate so we can summarize at run_finished. Cap the HEAD
        # of the buffer (first N chars), NOT the tail. Earlier we sliced
        # [-1000:] which kept the last 1000 chars — for any final text
        # block longer than 1KB the buffer started mid-word, the first-
        # sentence regex then grabbed the fragment after that mid-word
        # cut ("anup." instead of "cleanup. Now ..."). Reset on each
        # tool_use already caps the buffer per text block, so 5000 chars
        # is plenty of headroom for the first sentence to fit cleanly.
        if len(self._last_text_buf) < 5000:
            self._last_text_buf = (self._last_text_buf + text)[:5000]
        await self._put(msg("delta", project=self._project, run_id=self._run_id, text=text))

    async def emit_tool_use(self, *, name: str, input_data: dict, tool_use_id: str = "") -> None:
        # Forward tool calls to the client as compact cards. The frontend
        # decides how to render (Bash → command, Edit → file path, etc.) —
        # we just pass the parsed input through. tool_use_id pairs with
        # the matching tool_result so the client can show IN + OUT in one
        # card.
        # Reset the summary buffer: anything before this tool call is
        # mid-turn narration; what we want for the lock-screen body is
        # the text AFTER the last tool call (the "here's what I did"
        # wrap-up), which is what the user sees as Claude's final word.
        self._last_text_buf = ""
        await self._put(msg(
            "tool_use",
            project=self._project, run_id=self._run_id,
            name=name, input=input_data, tool_use_id=tool_use_id,
        ))

    async def emit_tool_error(self, *, text: str, tool_use_id: str = "") -> None:
        await self._put(msg(
            "tool_error",
            project=self._project, run_id=self._run_id,
            text=text, tool_use_id=tool_use_id,
        ))

    async def emit_tool_result(self, *, tool_use_id: str, text: str, is_error: bool) -> None:
        # OUT side of a tool call. Truncate aggressively — most users
        # care about the IN command; the OUT is a glanceable confirmation
        # plus enough text to debug if something went wrong. 2400 chars
        # is enough for a short PowerShell/Read result; longer outputs
        # are expandable on tap (handled client-side).
        clipped = (text or "")[:2400]
        await self._put(msg(
            "tool_result",
            project=self._project, run_id=self._run_id,
            tool_use_id=tool_use_id, text=clipped, is_error=is_error,
        ))

    async def emit_session_init(self, *, session_id: str) -> None:
        # Forward claude's session UUID so the client can store it on the
        # tab — used both to thread subsequent --resume runs and to
        # identify this conversation in the history list later.
        self._session_id = session_id
        await self._put(msg(
            "session_init",
            project=self._project, run_id=self._run_id,
            session_id=session_id,
        ))

    async def emit_usage(
        self,
        *,
        input_tokens: int,
        output_tokens: int,
        cache_read_tokens: int,
        cache_creation_tokens: int,
        context_used: int = 0,
        context_window: int | None = None,
        model: str = "",
        cost_usd: float | None = None,
    ) -> None:
        # Per-message usage from claude's stream-json plus a server-
        # computed `context_used` (cumulative token approximation for
        # the whole session up to now) plus the model id that actually
        # served this turn. The donut reads context_used to match
        # VSCode's `/context` display; the per-message fields feed the
        # tap-to-see-detail toast; the model id lets the client show
        # "Auto · Sonnet 4.6" so the user knows which model the picker's
        # Auto option resolved to.
        await self._put(msg(
            "usage",
            project=self._project, run_id=self._run_id,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_creation_tokens=cache_creation_tokens,
            context_used=context_used,
            model=model,
            # `cost_usd` only present on `result`-event-driven usage
            # frames (last frame of a run). Per-message `assistant`
            # events don't carry it. Client uses this to power /cost.
            cost_usd=cost_usd,
        ))

    async def emit_final(self) -> None:
        # No buffer to drain; deltas were forwarded raw. Nothing to do.
        return

    async def send_text(self, text: str, *, tag: str | None = None) -> None:
        await self._put(msg("text", project=tag, text=text))

    async def send_media(self, path: Path, *, tag: str) -> None:
        try:
            size = path.stat().st_size
        except OSError:
            return
        size_mb = size / (1024 * 1024)
        ext = path.suffix.lower()
        if size_mb > self._max_media_mb:
            await self.send_text(
                f"(skipped {path.name}: {size_mb:.1f} MB exceeds {self._max_media_mb} MB cap)",
                tag=tag,
            )
            return
        # Drop trailing media frames that arrive AFTER run_finished cleared
        # _run_id. The watcher's stabilize-and-upload task can race with
        # run end: by the time it calls send_media, _run_id is None.
        # Emitting `run_id: null` makes the client lazy-create a phantom
        # "null"-keyed entry in _activeRuns that never receives a real
        # run_finished, so the composer's stop button stays stuck. The
        # user just doesn't see this trailing image in chat — they can
        # still find it on disk under the project's watch folder.
        if self._run_id is None:
            log.info("dropping media frame for %s — no active run (run_finished already fired)", path.name)
            return
        url = self._media_url_for(path)
        mime = _guess_mime(ext)
        kind = "video" if mime.startswith("video/") else "image"
        # CRITICAL: include run_id so the client appends to the CURRENT
        # assistant message bubble. Without this, frame.run_id is
        # undefined and the client's appendMedia falls through to
        # beginRun(), creating a SECOND assistant container that never
        # receives run_finished — which leaves the stop button stuck
        # showing forever and breaks the "task complete" affordance.
        await self._put(msg(
            "media", project=tag, run_id=self._run_id,
            name=path.name, url=url, mime=mime,
            size=size, kind=kind,
        ))

    async def run_finished(
        self,
        *,
        project: str,
        run_id: int,
        outcome: str,
        detail: str = "",
        notify: bool = True,
    ) -> None:
        await self._put(msg(
            "run_finished",
            project=project, run_id=run_id,
            outcome=outcome, detail=detail,
        ))
        self._project = None
        self._run_id = None
        # Fire Web Push to subscribed devices on REAL completions only —
        # not on stopped runs (user already knows) or errors (separate
        # toast in the UI). Fire-and-forget so a slow push service can't
        # block subsequent runs. `notify=False` lets the caller suppress
        # push for compact / ask / smoke-probe runs the user isn't waiting on.
        if notify and self._push_notify and outcome == "done":
            try:
                # Build a 1-2 sentence summary from the trailing text the
                # assistant emitted after its last tool call. iOS lock-
                # screen banners comfortably fit ~200 chars of body
                # before truncation; we aim for 200 with a sentence-
                # boundary cut so the banner ends cleanly rather than
                # mid-word. Server-side prepends `[project]` to the
                # body, so save room for that prefix.
                # Body strategy: take the FIRST PARAGRAPH of the trailing
                # text (everything up to a blank line). My responses
                # typically open with a 1-3 sentence summary block —
                # "Found the bug! The watcher monitors..." — which is
                # exactly what the lock-screen banner should show. The
                # paragraph is then trimmed to ~200 chars at a sentence
                # boundary, falling back to a clean cut. No ellipsis,
                # no mid-word, no useless stubs like "Both findings: 1."
                raw_full = (self._last_text_buf or "").strip()
                # Take everything before the first blank line.
                first_para = raw_full.split("\n\n", 1)[0].strip()
                # Normalize whitespace inside the paragraph (single-line).
                first_para = " ".join(first_para.split())
                BODY_CAP = 200
                import re as _re
                if len(first_para) <= BODY_CAP:
                    summary = first_para
                else:
                    # Find the last sentence-terminator within BODY_CAP
                    # so we end on a complete thought. Require the cut
                    # to be at least 80 chars in so we don't end on a
                    # tiny stub like "Both findings: 1.".
                    cut_pos = -1
                    for tm in _re.finditer(r"[.!?](?:\s|$)", first_para[:BODY_CAP]):
                        if tm.end() >= 80:
                            cut_pos = tm.end()
                    if cut_pos > 0:
                        summary = first_para[:cut_pos].strip()
                    else:
                        # No clean cut — take first BODY_CAP chars,
                        # backtrack to the last word boundary.
                        slice_ = first_para[:BODY_CAP]
                        space = slice_.rfind(" ")
                        summary = (slice_[:space] if space > 60 else slice_).strip()
                if not summary:
                    summary = "Run finished"
                await self._push_notify(project, outcome, self._tab_id, summary, self._session_id or "")
            except Exception:
                log.warning("Push notify failed", exc_info=True)

    def keepalive_task(self) -> asyncio.Task[None] | None:
        # The WS client sends pings on its own clock; no server-side keepalive
        # task needed.
        return None


# Type alias for the URL factory the server hands to each sink.
from typing import Callable
MediaUrlFn = Callable[[Path], str]


_EXT_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
}


def _guess_mime(ext: str) -> str:
    return _EXT_MIME.get(ext.lower(), "application/octet-stream")
