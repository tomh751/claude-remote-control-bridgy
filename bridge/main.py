"""Bridge entry point — boots the web UI in one asyncio event loop.

The bridge serves a single transport: the FastAPI + WebSocket mobile PWA on
WEB_PORT (default 8787). Telegram support was removed in 2026-05-13; the web
UI is now the only client.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import socket
import sys

from .config import Config, load_config
from .sessions import SessionManager
from .state import BridgeState

log = logging.getLogger(__name__)


def _bind_exclusive_socket(host: str, port: int) -> socket.socket:
    # On Windows, two processes can bind the same port to *different*
    # specific addresses (e.g. our 0.0.0.0:8787 + another app's
    # 127.0.0.1:8787) — Winsock allows it by default and loopback then
    # silently routes to the squatter. SO_EXCLUSIVEADDRUSE blocks that:
    # any other process trying to bind anything on this port fails with
    # WSAEADDRINUSE. Reserves 8787 for the bridge alone.
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    if sys.platform == "win32":
        exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", 0x00000004)
        sock.setsockopt(socket.SOL_SOCKET, exclusive, 1)
    else:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((host, port))
    except OSError as e:
        sock.close()
        raise RuntimeError(
            f"port {port} is already in use — another process is holding it. "
            f"Stop it (or change WEB_PORT in .env.local) and retry. Underlying error: {e}"
        ) from e
    sock.listen(128)
    sock.setblocking(False)
    return sock


def _setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    # Belt-and-suspenders on uvicorn's own loggers. `access_log=False`
    # in the uvicorn Config silences uvicorn.access (the HTTP access
    # log), but it does NOT silence the websockets-protocol logger
    # which writes lines like:
    #   INFO: ('100.99.152.5', 0) - "WebSocket /ws?token=<hmac>" [accepted]
    # That format leaks the auth token (a 30-day session-equivalent
    # HMAC) into bridge.log.err on every WS upgrade. Suppress every
    # uvicorn-family logger at WARNING so connection lifecycle noise
    # AND the URL leak both disappear. Real errors still propagate.
    for name in (
        "uvicorn",
        "uvicorn.access",
        "uvicorn.error",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.websockets_impl",
        "uvicorn.protocols.websockets.wsproto_impl",
        "websockets",
        "websockets.server",
    ):
        logger = logging.getLogger(name)
        logger.setLevel(logging.WARNING)
        # uvicorn.access is the only logger we want completely silent
        # (no errors expected from access logging itself).
        if name == "uvicorn.access":
            logger.handlers = []
            logger.propagate = False
            logger.disabled = True


async def _run_web(cfg: Config, state: BridgeState, sessions: SessionManager) -> None:
    import uvicorn
    from .web.server import build_web_app

    app = build_web_app(cfg=cfg, state=state, sessions=sessions)
    server_cfg = uvicorn.Config(
        app,
        host=cfg.web_host,
        port=cfg.web_port,
        log_level=cfg.log_level.lower(),
        loop="asyncio",
        # Uvicorn installs its own signal handlers by default which clash
        # with our parent task management. We handle shutdown via task
        # cancellation.
        #
        # access_log=False because the WS endpoint accepts `?token=<hmac>`
        # for iOS Safari PWA compatibility (cookies don't always travel on
        # the WS upgrade), and uvicorn's default access log writes the
        # full URL to stdout — which means the token lands in logs and
        # could be replayed by anyone with log-file access until expiry.
        # Auth attempts + WS lifecycle are logged via the module logger
        # at LOG_LEVEL, with credentials elided.
        access_log=False,
        # log_config=None disables uvicorn's dictConfig pass at startup,
        # which would otherwise overwrite the levels set in
        # _setup_logging(). Without this, the websockets-protocol logger
        # comes back up at INFO and writes the `WebSocket /ws?token=...`
        # line to stderr on every connection — leaking the auth token.
        log_config=None,
    )
    # Re-apply log-level overrides AFTER uvicorn.Config — its __init__
    # touches the uvicorn-family logger levels (even with log_config=None)
    # and resets whatever _setup_logging() configured. Doing it here is
    # what actually sticks for the lifetime of the server.
    for name in (
        "uvicorn",
        "uvicorn.access",
        "uvicorn.error",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.websockets_impl",
        "uvicorn.protocols.websockets.wsproto_impl",
        "websockets",
        "websockets.server",
    ):
        logging.getLogger(name).setLevel(logging.WARNING)
    server = uvicorn.Server(server_cfg)
    # Disable uvicorn's signal handlers — main() owns SIGINT/SIGTERM.
    server.install_signal_handlers = lambda: None  # type: ignore[method-assign]
    # Pre-bind the listening socket so we can set SO_EXCLUSIVEADDRUSE on
    # Windows. uvicorn accepts a pre-bound socket via serve(sockets=[...])
    # and skips its own bind step.
    listen_sock = _bind_exclusive_socket(cfg.web_host, cfg.web_port)
    log.info("web UI online: http://%s:%s (Tailscale: open this on the phone)", cfg.web_host, cfg.web_port)
    try:
        await server.serve(sockets=[listen_sock])
    except asyncio.CancelledError:
        log.info("web server shutting down")
        server.should_exit = True
        raise
    finally:
        try:
            listen_sock.close()
        except OSError:
            pass


async def _main_async() -> None:
    cfg = load_config()
    _setup_logging(cfg.log_level)

    state = BridgeState(default_root=cfg.projects_root)
    sessions = SessionManager(cfg=cfg, state=state)

    log.info(
        "bridge online — projects_root=%s web=on (web-only build)",
        cfg.projects_root,
    )

    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def _request_stop() -> None:
        log.info("signal received, stopping")
        stop_event.set()

    if sys.platform != "win32":
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, _request_stop)

    web_task = asyncio.create_task(_run_web(cfg, state, sessions), name="web")
    # Preload the Whisper model in the background so the first mic
    # transcription doesn't pay a 1-2s cold-start tax. Failure to load
    # is non-fatal — the mic endpoint will surface a clear error if a
    # real request hits a still-broken model.
    async def _preload_whisper() -> None:
        try:
            from .web.transcribe import _load_model
            await asyncio.to_thread(_load_model)
        except Exception:  # noqa: BLE001
            log.warning("whisper preload failed (mic will still try on first request)", exc_info=True)
    asyncio.create_task(_preload_whisper(), name="whisper-preload")
    stop_wait = asyncio.create_task(stop_event.wait(), name="stop-wait")
    await asyncio.wait(
        [web_task, stop_wait],
        return_when=asyncio.FIRST_COMPLETED,
    )
    stop_wait.cancel()
    web_task.cancel()
    await asyncio.gather(web_task, return_exceptions=True)
    log.info("stopping all sessions")
    await sessions.stop_all()


def main() -> None:
    try:
        asyncio.run(_main_async())
    except KeyboardInterrupt:
        # Windows path: signal handlers don't run inside add_signal_handler,
        # so KeyboardInterrupt propagates here. asyncio.run cancels tasks
        # for us before raising.
        pass
    except RuntimeError as e:
        # Config errors — log plainly, no traceback.
        log.error("Bridge failed to start: %s", e)
        sys.exit(2)


if __name__ == "__main__":
    main()
