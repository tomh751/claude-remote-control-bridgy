"""Environment loading + project path resolution.

PROJECTS_ROOT is the single source of truth for what folders can be operated
on. resolve_project() is the only sanctioned way to turn a user-supplied
project name into a filesystem path — every other module must call it rather
than do its own joining.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


_PROJECT_ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(_PROJECT_ROOT_DIR / ".env.local")


def _require(name: str) -> str:
    val = os.getenv(name, "").strip()
    if not val:
        raise RuntimeError(
            f"{name} is missing from .env.local. Copy .env.local.example, fill "
            f"in the values, and restart the bridge."
        )
    return val


@dataclass(frozen=True)
class Config:
    projects_root: Path
    claude_cmd: str
    default_permission_mode: str
    claude_model: str
    watch_folders: tuple[str, ...]
    max_media_mb: int
    log_level: str
    # Web UI server: the bridge starts a FastAPI server that the iPhone PWA
    # connects to over Tailscale. web_password gates access; the phone trades
    # it once for an auth cookie. Empty password is a fatal config error
    # (we refuse to start an unprotected server).
    web_host: str
    web_port: int
    web_password: str
    web_cookie_secure: bool
    # Resource caps — protect the bridge from a logged-in client that's either
    # buggy or actively trying to OOM/saturate it.
    web_max_upload_mb: int       # /api/upload per-request body cap
    web_max_ws_frame_kb: int     # WS frame size cap (covers giant prompt texts)
    max_concurrent_runs: int     # ceiling on simultaneous `claude -p` subprocesses
    # The public HTTPS URL the bridge is reachable at (typically a Tailscale
    # Serve URL like https://laptop.tailXXXX.ts.net). If set, the static HTML
    # pages auto-redirect HTTP visitors to this URL — mic, Face ID, and
    # other "secure context" APIs require https. Empty disables the redirect.
    web_https_url: str
    # Laptop's LAN IPv4. Auto-detected at startup; overridable via LAN_IP env
    # var if the user's network setup needs a specific interface. Used by
    # the bridge's system prompt to tell Claude "your dev-server URL on the
    # phone is http://<this-ip>:<port>" — without it Claude has no idea what
    # IP to report when the user asks "start the dev server, I'll open it
    # from my phone."
    lan_ip: str
    # If true, the workspace picker (Menu -> Workspace) refuses to browse
    # outside projects_root. Default false preserves the original UX where
    # the picker can jump to Home / Desktop / Documents / arbitrary paths.
    # Recommended `true` if anyone besides the bridge owner can reach the
    # service — limits the impact if the password ever leaks.
    workspace_root_lock: bool
    # VAPID `sub` claim for Web Push JWTs. APNs / FCM reject tokens whose
    # `sub` host isn't a real-looking domain — `bridge@localhost` returns
    # 403 BadJwtToken. Default is the reserved RFC 2606 example.com; users
    # set `WEB_PUSH_EMAIL=mailto:you@yourdomain.com` to override.
    web_push_email: str
    # Shared secret for the /api/trigger/{token} endpoint. The bridge
    # exposes one local-only trigger URL so Claude (running in auto mode)
    # can self-schedule check-ins via the OS scheduler (Windows Task
    # Scheduler / cron / launchd). The token is generated on first boot
    # and persisted in `<projects_root>/.crc-trigger-token`. It is NOT
    # the same as the web auth cookie — it's a single long-lived bearer
    # token for unauthenticated local processes. Keep it on the laptop
    # (the trigger endpoint binds to 127.0.0.1 only).
    trigger_token: str


def _truthy(raw: str) -> bool:
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _discover_lan_ip() -> str:
    """Best-effort LAN IPv4 detection. Opens a UDP socket to a public IP
    (no packets actually sent — `connect()` on UDP just picks an interface)
    and reads back the local endpoint the OS chose. Returns "" on failure,
    in which case the bridge's system prompt drops the LAN-URL hint and
    Claude will figure out bindings from its own `ipconfig`/`hostname -I`
    calls when needed."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(0.5)
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0] or ""
        finally:
            s.close()
    except OSError:
        return ""


def load_config() -> Config:
    projects_root = Path(_require("PROJECTS_ROOT")).resolve()
    if not projects_root.is_dir():
        raise RuntimeError(
            f"PROJECTS_ROOT does not exist or is not a directory: {projects_root}"
        )

    perm_mode = os.getenv("CLAUDE_DEFAULT_PERMISSION_MODE", "auto").strip().lower()
    if perm_mode not in {"auto", "plan", "edits"}:
        raise RuntimeError(
            f"CLAUDE_DEFAULT_PERMISSION_MODE must be one of auto|plan|edits, got {perm_mode!r}"
        )

    watch_raw = os.getenv("WATCH_FOLDERS", "assets,output,screenshots")
    watch_folders = tuple(
        s.strip() for s in watch_raw.split(",") if s.strip()
    )

    try:
        max_media_mb = int(os.getenv("MAX_MEDIA_MB", "20"))
    except ValueError as e:
        raise RuntimeError("MAX_MEDIA_MB must be an integer") from e

    web_host = os.getenv("WEB_HOST", "0.0.0.0").strip() or "0.0.0.0"
    try:
        web_port = int(os.getenv("WEB_PORT", "8787"))
    except ValueError as e:
        raise RuntimeError("WEB_PORT must be an integer") from e
    # WEB_PASSWORD is the user-chosen password typed on the phone. Falls
    # back to WEB_AUTH_TOKEN for backward-compat with old configs.
    web_password = (os.getenv("WEB_PASSWORD", "") or os.getenv("WEB_AUTH_TOKEN", "")).strip()
    if not web_password:
        raise RuntimeError(
            "WEB_PASSWORD is empty. The web UI would be wide open on "
            "whatever interface it binds to — refusing to start. Set "
            "WEB_PASSWORD to something memorable in .env.local."
        )
    if len(web_password) < 10:
        raise RuntimeError(
            "WEB_PASSWORD must be at least 10 characters. Pick a passphrase "
            "(e.g. 'correct-horse-battery'), not a single short word. The "
            "bridge's rate limiter buys you time against online brute-force "
            "but not unlimited time — the password is your last line of "
            "defense if Tailscale isolation ever fails."
        )

    web_cookie_secure = _truthy(os.getenv("CRC_COOKIE_SECURE", "false"))
    web_https_url = os.getenv("CRC_HTTPS_URL", "").strip().rstrip("/")
    try:
        web_max_upload_mb = int(os.getenv("WEB_MAX_UPLOAD_MB", "50"))
    except ValueError as e:
        raise RuntimeError("WEB_MAX_UPLOAD_MB must be an integer") from e
    try:
        web_max_ws_frame_kb = int(os.getenv("WEB_MAX_WS_FRAME_KB", "256"))
    except ValueError as e:
        raise RuntimeError("WEB_MAX_WS_FRAME_KB must be an integer") from e
    try:
        max_concurrent_runs = int(os.getenv("MAX_CONCURRENT_RUNS", "6"))
    except ValueError as e:
        raise RuntimeError("MAX_CONCURRENT_RUNS must be an integer") from e
    if max_concurrent_runs < 1:
        raise RuntimeError("MAX_CONCURRENT_RUNS must be >= 1")

    return Config(
        projects_root=projects_root,
        claude_cmd=os.getenv("CLAUDE_CMD", "claude").strip() or "claude",
        default_permission_mode=perm_mode,
        claude_model=os.getenv("CLAUDE_MODEL", "").strip(),
        watch_folders=watch_folders,
        max_media_mb=max_media_mb,
        log_level=os.getenv("LOG_LEVEL", "INFO").strip().upper(),
        web_host=web_host,
        web_port=web_port,
        web_password=web_password,
        web_cookie_secure=web_cookie_secure,
        web_max_upload_mb=web_max_upload_mb,
        web_max_ws_frame_kb=web_max_ws_frame_kb,
        max_concurrent_runs=max_concurrent_runs,
        web_https_url=web_https_url,
        lan_ip=os.getenv("LAN_IP", "").strip() or _discover_lan_ip(),
        # Default `true`: the workspace picker stays confined to
        # PROJECTS_ROOT. Set WORKSPACE_ROOT_LOCK=false in .env.local
        # to opt back into the wider "browse the whole laptop" UX.
        workspace_root_lock=_truthy(os.getenv("WORKSPACE_ROOT_LOCK", "true")),
        web_push_email=os.getenv("WEB_PUSH_EMAIL", "mailto:webpush@example.com").strip(),
        trigger_token=_load_or_generate_trigger_token(projects_root),
    )


def _load_or_generate_trigger_token(projects_root: Path) -> str:
    """Read the OS-trigger token from <projects_root>/.crc-trigger-token, or
    generate a fresh 32-byte URL-safe token and persist it. Allows scheduled
    OS tasks (Windows Task Scheduler / cron) to POST /api/trigger/<token>
    without a browser auth cookie."""
    import secrets
    token_path = projects_root / ".crc-trigger-token"
    try:
        if token_path.is_file():
            tok = token_path.read_text(encoding="utf-8").strip()
            if tok and len(tok) >= 20:
                return tok
    except OSError:
        pass
    tok = secrets.token_urlsafe(32)
    try:
        token_path.write_text(tok, encoding="utf-8")
    except OSError:
        # Non-fatal: token still works in-memory, just won't survive restart.
        pass
    return tok


class ProjectNotFound(ValueError):
    """Raised when a project name can't be resolved to a valid path under root."""


def resolve_project(root: Path, name: str) -> Path:
    """Turn a user-supplied project name into a vetted absolute path under `root`.

    Rejects: empty names, '..' anywhere, absolute paths, drive letters,
    any name that — after symlink resolution — escapes `root`. `root`
    itself is the trust boundary; callers MUST pass a path the bridge
    has already vetted (cfg.projects_root or a value the user has
    activated via the workspace endpoints in BridgeState.allowed_roots).
    """
    name = (name or "").strip()
    if not name:
        raise ProjectNotFound("Project name is empty.")
    if ".." in Path(name).parts:
        raise ProjectNotFound("Project name contains '..' — refusing.")
    p = Path(name)
    if p.is_absolute() or p.drive:
        raise ProjectNotFound("Project name must be relative — refusing absolute path.")

    root_resolved = root.resolve()
    candidate = (root_resolved / name).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError as e:
        raise ProjectNotFound(
            f"Resolved path {candidate} escapes workspace root {root_resolved}."
        ) from e
    if not candidate.is_dir():
        raise ProjectNotFound(f"Project folder does not exist: {name}")
    return candidate


def list_projects(root: Path) -> list[str]:
    """Return sorted names of immediate subfolders under `root`. Hidden
    folders (leading `.`) are filtered out — they're bridge-internal
    (e.g. `.crc-tmp`, `.web-uploads`) and not user projects."""
    try:
        return sorted(
            p.name for p in root.iterdir()
            if p.is_dir() and not p.name.startswith(".")
        )
    except OSError:
        return []
