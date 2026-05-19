"""Protocol that decouples the session manager from any specific UI transport.

A `RunSink` is the destination for everything one `claude -p` run wants to
say to whoever asked for it. Currently the only implementation is `WebSink`
(bridge/web/sink.py), which streams deltas raw to a WebSocket so the phone
sees text typing live and forwards structured run-lifecycle events the
frontend renders as spinners / final-state cards.

The Protocol stays narrow so SessionManager only knows "I have a thing that
wants to know when a run starts, what text claude wrote, what files
appeared, and when the run ended." Everything UI-specific lives behind it.

Earlier in development the bridge also shipped a `TelegramSink` that
batched deltas at sentence boundaries and edited a status message with a
Stop button. That transport was removed on 2026-05-13; the docstring on
each method below mentions a "batching sink" only as historical context
in case the pattern returns.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable


@runtime_checkable
class RunSink(Protocol):
    """Receives lifecycle + content events from one `claude -p` run.

    Call order, per run:
        run_started → (emit_delta* + emit_media*) → emit_final → run_finished

    Methods are async and may raise; SessionManager logs and continues so a
    broken transport doesn't take the subprocess down with it.
    """

    async def run_started(self, *, project: str, run_id: int) -> None:
        """Called once at the top of a run. Sink should show a 'working'
        indicator and stash `project` / `run_id` for subsequent events."""
        ...

    async def emit_delta(self, text: str) -> None:
        """Streamed text chunk from claude's stdout. May be a single
        character or a full sentence. WebSink forwards raw; a hypothetical
        batching sink would buffer until a sentence boundary."""
        ...

    async def emit_tool_use(
        self,
        *,
        name: str,
        input_data: dict,
        tool_use_id: str = "",
    ) -> None:
        """A tool invocation Claude is about to make (Bash, Edit, Read, Write,
        WebFetch, etc). `input_data` is the parsed tool input — e.g. for Edit
        it has {file_path, old_string, new_string}; for Bash {command, description}.
        `tool_use_id` is the claude-assigned id (e.g. "toolu_01...") used
        to pair this IN card with its OUT (tool_result) on transports that
        show both. WebSink renders an expandable card; minimal transports
        could omit tool rendering entirely."""
        ...

    async def emit_tool_error(self, *, text: str, tool_use_id: str = "") -> None:
        """A tool result came back with is_error=true. Surface the error to
        the user so they can see WHY a write/edit/bash call failed. Without
        this they only saw the tool_use card + claude's vague follow-up text
        ('I tried to edit but couldn't…'). tool_use_id is threaded through
        so the client can suppress the red card for tools whose error is
        synthetic — AskUserQuestion always errors in `-p` mode since there
        is no interactive answer round-trip."""
        ...

    async def emit_tool_result(
        self,
        *,
        tool_use_id: str,
        text: str,
        is_error: bool,
    ) -> None:
        """The OUT side of a tool call — what the tool returned to claude.
        Paired with a prior emit_tool_use by `tool_use_id`. WebSink
        renders this as a collapsed result panel under the IN card."""
        ...

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
        """Per-message token counts from claude's stream-json `usage`
        field. WebSink forwards this so the client can render the
        context-usage donut inside the composer pill."""
        ...

    async def emit_session_init(self, *, session_id: str) -> None:
        """Claude's session UUID for this run, captured from the first
        system.init event. WebSink forwards this to the client so the tab
        can store the id (used to resume the same conversation on
        subsequent messages, and to list/open this session in the
        history sheet later)."""
        ...

    async def emit_final(self) -> None:
        """Called after the subprocess exits but before run_finished. Sinks
        that batch must drain any buffered text here so the trailing partial
        sentence reaches the user before the 'done' indicator."""
        ...

    async def send_text(self, text: str, *, tag: str | None = None) -> None:
        """Send a non-streamed text message (errors, 'busy', /help output).
        `tag` is the project name for transports that prefix it."""
        ...

    async def send_media(self, path: Path, *, tag: str) -> None:
        """Upload an image/video that the watcher saw appear. Sinks may skip
        files they can't handle (size cap, unsupported extension)."""
        ...

    async def run_finished(
        self,
        *,
        project: str,
        run_id: int,
        outcome: str,  # "done" | "stopped" | "error"
        detail: str = "",
        notify: bool = True,
    ) -> None:
        """Final lifecycle event. Sink should clear its 'working' indicator
        and surface the outcome. Sinks own any keepalive tasks they spawn
        (typing indicator, heartbeat) and must stop them here even if
        finalization raises.

        `notify=False` suppresses any user-facing background notification
        (e.g. Web Push to the phone). Set False for runs the user isn't
        watching the screen for and didn't initiate as a "fire and check
        back later" — auto-compact, /ask quick questions, internal probes."""
        ...
