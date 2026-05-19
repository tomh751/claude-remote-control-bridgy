"""WebSocket JSON protocol between the iPhone PWA and the bridge.

Both directions are line-delimited JSON objects with a `type` field. Keeping
the shapes simple — no nested envelopes, no client-side ack ids — because the
WebSocket itself is ordered and the only client is the PWA, so we can change
both ends together when needed.

Server → client message types:
    hello       — sent once after auth; carries projects list, default mode, current state
    run_started — a claude run began (project, run_id, prompt the server received)
    delta       — streamed text delta from claude (text)
    media       — a watcher-detected image/video was uploaded (url, project, name, mime)
    text        — a non-streamed system text (errors, "busy", /help output)
    run_finished — run ended (outcome: done|stopped|error, detail)
    state       — updated state snapshot after a command (active_project, permission_mode)
    error       — protocol/usage error message
    pong        — heartbeat response

Client → server message types:
    ping        — heartbeat
    prompt      — user submitted a chat message (text, project_override?, attachments[])
    command     — slash command (cmd, args)
    set_mode    — set permission mode (mode: auto|plan|edits|ask)
    set_project — set active project (project)
    stop        — stop the currently-running session in the active project
"""

from __future__ import annotations

from typing import Any


def msg(type_: str, **fields: Any) -> dict[str, Any]:
    """Build a server→client message dict."""
    out: dict[str, Any] = {"type": type_}
    out.update(fields)
    return out
