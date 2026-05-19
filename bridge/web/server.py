"""FastAPI server for the mobile PWA.

Single-user by design. The user logs in once on their phone with a
password from `.env.local`; the browser stores an HMAC-signed HttpOnly
cookie. WebSocket upgrades inherit the cookie auth automatically.

The PWA is plain HTML/CSS/JS in `static/` — no build step, no bundler, no node.
That keeps "I touched the bridge" → "phone shows it" instant.

Tailscale-only deployment is recommended (bind to 0.0.0.0; the Tailscale ACL
takes care of who can reach the laptop). For LAN-only use the same setup works
without Tailscale; for public exposure use cloudflared in front and treat
WEB_PASSWORD (HMAC-signed `crc_auth` cookie) as the only auth.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import mimetypes
import re
import secrets
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

# Make sure web fonts get a font/woff2 (resp. font/woff) Content-Type so
# iOS Safari accepts them. Python's mimetypes registry on Windows often
# doesn't ship these out of the box, so StaticFiles falls back to
# text/plain — which iOS rejects with no error visible to JS, breaking
# self-hosted webfonts. Register here, before StaticFiles is mounted.
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("font/otf", ".otf")
from pathlib import Path
from typing import Any

from urllib.parse import quote, urlparse

from fastapi import (
    Body, Cookie, Depends, FastAPI, File, Form, HTTPException, Request,
    UploadFile, WebSocket, WebSocketDisconnect, status,
)
from fastapi.responses import (
    FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response,
)
from fastapi.staticfiles import StaticFiles

from ..config import Config, ProjectNotFound, list_projects, resolve_project
from ..jsonl_helpers import _TOOL_RESULT_CAP_CHARS, count_event_chars, count_session_context, find_session_dir
from ..sessions import SessionManager, _INLINE_IMAGE_EXTS
from ..state import BridgeState
from .passkeys import PasskeyManager
from .push import build_push_manager
from .protocol import msg
from .sink import WebSink

log = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────

AUTH_COOKIE = "crc_auth"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days
# iOS / Capacitor companion uses the same HMAC token format as the cookie,
# just presented as `Authorization: Bearer <token>`. Longer TTL since
# Keychain storage is stickier than a browser cookie — users don't expect
# to retype credentials after every 30 days on a native app.
BEARER_MAX_AGE = 60 * 60 * 24 * 90  # 90 days
WS_OUTBOUND_QSIZE = 256

# Windows: hide console window on every child process the bridge spawns
# (claude / cmd.exe / git / taskkill / powershell). Without this, each
# spawn flashes a black terminal on the user's desktop because the
# parent pythonw.exe has no console of its own. Linux/Mac: undefined,
# so we fall back to 0 (no-op).
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
MEDIA_TOKEN_TTL_S = 60 * 60 * 6  # 6h — long enough for the user to scroll back through a chat

# Brute-force defense on /login. 5 attempts per IP per minute, then 429.
# Tailscale already restricts which IPs can reach us, but this layer means a
# leaked phone can't be brute-forced from another device on the same tailnet.
LOGIN_RATE_WINDOW_S = 60.0
LOGIN_RATE_MAX = 5

# Custom header required on every mutating POST except /login. Defeats CSRF:
# browsers do not send custom headers in cross-origin fetches without CORS
# preflight, and we never serve a permissive CORS header. samesite=lax alone
# is not enough — a same-site page on a different port (e.g. a Vite dev
# server claude itself spawned) can still POST with credentials.
CSRF_HEADER = "X-CRC-Request"
CSRF_VALUE = "1"

_STATIC_DIR = Path(__file__).resolve().parent / "static"
# Web-UI uploads (images and files the user attaches from the phone). Were
# stored per-project at `<project>/.web-uploads/` originally; centralized to
# `<PROJECTS_ROOT>/.web-uploads/<project>/` so the user can manage them in
# one place from the Manage Uploads menu. `_uploads_base_dir(root)` returns
# the root folder; `_uploads_dir_for(root, project)` returns the per-project
# subfolder.
_UPLOAD_DIR_NAME = ".web-uploads"


def _uploads_base_dir(projects_root: Path) -> Path:
    """The single top-level `.web-uploads/` folder under projects_root."""
    return projects_root / _UPLOAD_DIR_NAME


def _uploads_dir_for(projects_root: Path, project_name: str) -> Path:
    """Per-project subfolder where new uploads land."""
    return _uploads_base_dir(projects_root) / project_name


# NOTE: A one-shot `_migrate_legacy_uploads` helper used to live here to
# walk the old `<project>/.web-uploads/` layout and move files into the
# centralized `<PROJECTS_ROOT>/.web-uploads/<project>/` layout. It was
# only relevant for the maintainer's own machine during the layout
# refactor — new installs land in the centralized location from day one.
# Removed before the public release. If you ever need to re-migrate
# files manually, just `mv <project>/.web-uploads/* <PROJECTS_ROOT>/.web-uploads/<project>/`.

# Per-tab model override gets passed through to `claude --model <name>`. We
# whitelist the family rather than echoing whatever string the client sent —
# defense in depth in case a tampered frame slips through CSRF (an arbitrary
# `--model` value gives an attacker no real power, but tightening anyway).
_VALID_CLAUDE_MODEL_RE = re.compile(r"^claude-(opus|sonnet|haiku)-\d+[-\d]*$")

def _is_valid_claude_model(name: str) -> bool:
    return bool(_VALID_CLAUDE_MODEL_RE.match(name))

# Force the browser to refetch HTML every visit. Without this, iOS Safari
# caches the login/chat pages aggressively and the user sees stale UI for
# minutes-to-hours after a code change. Static assets (CSS/JS) get a
# version-string query in the HTML to invalidate them when they change.
_HTML_NO_CACHE = {"Cache-Control": "no-store, must-revalidate", "Pragma": "no-cache"}

# Asset version — `1.0.<n>` semver-ish patch counter that auto-increments
# whenever any file in `_VERSIONED_FILES` is touched. The hello frame,
# runtime-config.js, and the `?v=` cache-bust query strings in HTML all
# read from `_get_asset_version()` at request time, so a running bridge
# can never disagree with what's on disk (the bug that fired the "tap
# to reload" banner forever even on cold launches).
#
# The counter is persisted in `_ASSET_VERSION_STATE` alongside the last
# mtime we saw. On every request we re-read the static files' mtimes;
# if the max is newer than what we stored, we bump the counter and
# rewrite the state file. Otherwise we just return the existing value.
_VERSIONED_FILES: tuple[str, ...] = (
    "index.html", "login.html", "app.js", "app.css", "ptr.js", "sw.js",
)
# Lives next to bridge/web/, NOT inside static/, so its own mtime change
# can never trigger a version bump (which would loop forever).
_ASSET_VERSION_STATE = _STATIC_DIR.parent / ".asset-version"
# Seed counter — picks up from where the last hand-bumped version left
# off (1.0.92), so iPhones already on 1.0.92 see a clean `1.0.93` next.
_ASSET_VERSION_SEED = 92

def _get_asset_version() -> str:
    """`1.0.<n>` patch counter. Bumped whenever any `_VERSIONED_FILES`
    file's mtime exceeds the last seen value. Cheap: a handful of
    `stat()` calls plus at most one tiny read + write per actual bump."""
    max_mt = 0.0
    for name in _VERSIONED_FILES:
        try:
            mt = (_STATIC_DIR / name).stat().st_mtime
            if mt > max_mt:
                max_mt = mt
        except FileNotFoundError:
            continue
    last_mt = 0.0
    counter = _ASSET_VERSION_SEED
    try:
        raw = _ASSET_VERSION_STATE.read_text(encoding="utf-8").strip()
        mt_s, counter_s = raw.split(":", 1)
        last_mt = float(mt_s)
        counter = int(counter_s)
    except (FileNotFoundError, ValueError, OSError):
        # Fresh install or corrupted file — fall through and persist below.
        pass
    if max_mt > last_mt:
        counter += 1
        try:
            _ASSET_VERSION_STATE.write_text(
                f"{max_mt}:{counter}", encoding="utf-8"
            )
        except OSError:
            # Persistence failed (read-only fs, etc.) — we still return a
            # bumped value for this process; the next process will bump
            # again, which is harmless (cache-busts twice).
            pass
    return f"1.0.{counter}"

# Claude Code session-id shape: file basenames in ~/.claude/projects/<cwd>/
# follow this pattern (UUID-ish, plus tolerated underscores/hyphens). Every
# endpoint that accepts a session UUID from the client uses this — kept as
# one source of truth so a shape tweak only needs one edit.
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
_AGENT_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# NTFS-specific filename guards. The Path(name).name strip handles forward and
# back slashes but lets these through:
#  - "photo.png:hidden"  → creates an alternate data stream on photo.png
#  - "CON", "NUL", "COM1" etc. → Windows reserved device names; writes hang
_NTFS_RESERVED = frozenset({
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
})


# ── Session cookie ───────────────────────────────────────────────────────
#
# Format: "<expiry_unix>.<base64url(hmac_sha256(secret, expiry_unix))>"
#
# The cookie is self-validating — server holds NO session state, so cookies
# survive bridge restarts (was a real annoyance with the random-token-in-set
# design). The HMAC key is derived from the user's password, so changing
# WEB_PASSWORD instantly invalidates every outstanding session without
# anything else to remember to clear.

def _session_secret(password: str) -> bytes:
    return hashlib.sha256(password.encode("utf-8")).digest()


def _mint_session_cookie(password: str, *, ttl_s: int = COOKIE_MAX_AGE) -> str:
    expiry = int(time.time()) + ttl_s
    payload = str(expiry).encode("utf-8")
    sig = hmac.new(_session_secret(password), payload, hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")
    return f"{expiry}.{sig_b64}"


def _verify_session_cookie(password: str, value: str | None) -> bool:
    if not value or not password:
        return False
    try:
        expiry_str, sig_b64 = value.split(".", 1)
        expiry = int(expiry_str)
    except (ValueError, AttributeError):
        return False
    if time.time() > expiry:
        return False
    expected = hmac.new(_session_secret(password), expiry_str.encode("utf-8"), hashlib.sha256).digest()
    try:
        # Re-pad and decode the urlsafe base64.
        padded = sig_b64 + "=" * (-len(sig_b64) % 4)
        actual = base64.urlsafe_b64decode(padded.encode("ascii"))
    except Exception:
        return False
    return hmac.compare_digest(expected, actual)


def _safe_upload_name(raw: str) -> str | None:
    """Return a filesystem-safe filename for an upload, or None if rejected.

    Strips any path components, NTFS alt-stream syntax, and reserved names.
    Caller still puts the file under <project>/.web-uploads/<uuid>_<name>.
    """
    name = Path(raw or "file.bin").name
    # NTFS alt streams: anything after the first ':' addresses a hidden stream
    # on the file. We don't want a client to write to streams on files that
    # already exist (or might in the future).
    name = name.split(":", 1)[0]
    # Strip trailing dots/spaces — Windows ignores them but they confuse
    # tooling that calls os.path.basename downstream.
    name = name.rstrip(". ")
    if not name:
        return None
    stem_upper = name.split(".", 1)[0].upper()
    if stem_upper in _NTFS_RESERVED:
        return None
    return name


# ── App factory ──────────────────────────────────────────────────────────

def build_web_app(*, cfg: Config, state: BridgeState, sessions: SessionManager) -> FastAPI:
    app = FastAPI(title="Bridgy", docs_url=None, redoc_url=None)

    # Holds opaque tokens → absolute paths so the watcher's media files can be
    # served without leaking server filesystem layout. Tokens are random 32-byte
    # url-safe strings and expire after MEDIA_TOKEN_TTL_S.
    media_tokens: dict[str, tuple[Path, float]] = {}

    # iOS pairing registry: device_id → {label, paired_at, expires_at, ...}.
    # Populated by POST /api/pair. Restart-resetable (devices re-pair on next
    # launch via the same flow). See the "Mobile-app pairing" section below.
    mobile_devices: dict[str, dict[str, Any]] = {}

    # Per-session locks so a phone double-tap or a Safari retry can't drive
    # two concurrent compact_inplace requests against the same jsonl —
    # which would otherwise both read the same last-assistant uuid and
    # append two boundary/seed pairs. Allocated lazily; never expires
    # since sessions are bounded and these locks are tiny.
    compact_locks: dict[str, asyncio.Lock] = {}

    def _compact_lock_for(session_id: str) -> asyncio.Lock:
        lk = compact_locks.get(session_id)
        if lk is None:
            lk = asyncio.Lock()
            compact_locks[session_id] = lk
        return lk

    def _register_media(path: Path) -> str:
        tok = secrets.token_urlsafe(24)
        media_tokens[tok] = (path, time.time() + MEDIA_TOKEN_TTL_S)
        # Sweep expired tokens opportunistically; cheap.
        now = time.time()
        for k in [k for k, (_, exp) in media_tokens.items() if exp < now]:
            media_tokens.pop(k, None)
        return f"/media/{tok}"

    # ── Auth helpers ─────────────────────────────────────────────────────

    # Per-IP FAILED login-attempt log. Only failures are counted — a user
    # who legitimately authenticates several times in quick succession (e.g.
    # debugging from multiple devices) must not get locked out by their own
    # successful logins.
    #
    # Two separate buckets so a flood on /api/pair (iOS endpoint) can't
    # also lock the PWA's /login flow — and vice versa. Otherwise an
    # adversary on the same tailnet could brute /api/pair until the budget
    # was burned, then the user's own phone hits 429 on /login. Same
    # numeric budget, separate counters.
    login_attempts: dict[str, list[float]] = {}
    pair_attempts: dict[str, list[float]] = {}

    def _rate_limit_ok(ip: str, *, bucket: dict[str, list[float]] | None = None) -> bool:
        """True if `ip` is still under the failure budget for the given bucket.
        Pure read — does NOT record this call. Defaults to the PWA /login
        bucket when no bucket is passed (backwards-compatible)."""
        if bucket is None:
            bucket = login_attempts
        now = time.time()
        attempts = [t for t in bucket.get(ip, []) if now - t < LOGIN_RATE_WINDOW_S]
        bucket[ip] = attempts          # gc stale entries
        return len(attempts) < LOGIN_RATE_MAX

    def _rate_limit_record_failure(ip: str, *, bucket: dict[str, list[float]] | None = None) -> None:
        """Append a failure timestamp for `ip` in the given bucket."""
        if bucket is None:
            bucket = login_attempts
        now = time.time()
        attempts = [t for t in bucket.get(ip, []) if now - t < LOGIN_RATE_WINDOW_S]
        attempts.append(now)
        bucket[ip] = attempts

    def _is_authed(cookie_val: str | None) -> bool:
        # The cookie is a self-validating HMAC blob, not the password itself.
        # Even if it were exfiltrated from the browser, it cannot be used to
        # recover the password.
        return _verify_session_cookie(cfg.web_password, cookie_val)

    def _bearer_token(request: Request) -> str | None:
        h = request.headers.get("authorization")
        if not h or not h.lower().startswith("bearer "):
            return None
        return h[7:].strip() or None

    def require_auth(
        request: Request,
        crc_auth: str | None = Cookie(default=None, alias=AUTH_COOKIE),
    ) -> None:
        # Accept either the PWA cookie (HMAC same-format) OR an
        # `Authorization: Bearer <token>` header from the iOS app. The
        # token format is identical; both go through _verify_session_cookie.
        if _is_authed(crc_auth):
            return
        bearer = _bearer_token(request)
        if bearer and _is_authed(bearer):
            return
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    def require_csrf(request: Request) -> None:
        """Require the custom header on every mutating POST except /login.

        Defends against cookie-credentialed cross-origin POSTs (CSRF) that
        samesite=lax does not block — e.g., a same-site page on another
        port that a malicious claude run set up.
        """
        if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Missing CSRF header")

    max_upload_bytes = cfg.web_max_upload_mb * 1024 * 1024

    async def _read_capped(upload: UploadFile, *, limit: int) -> bytes:
        """Read an UploadFile in 64 KB chunks, refusing once we cross `limit`.

        UploadFile.read() with no arg buffers the entire body in memory; for a
        single-user bridge that's a trivial OOM vector even from an authed
        client. We bound it.
        """
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = await upload.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise HTTPException(
                    status_code=413,
                    detail=f"Upload exceeds {limit // (1024 * 1024)} MB cap",
                )
            chunks.append(chunk)
        return b"".join(chunks)

    def _maybe_shrink_image(data: bytes, content_type: str | None) -> bytes:
        """Downscale large images to fit Anthropic's per-image dimension
        cap (2000 px on the longest edge for any image in a multi-image
        message). Targets 1568 px — Anthropic's documented cost-optimal
        size — using Pillow's LANCZOS resampling. Re-encodes JPEG at
        quality=85 (visually transparent, halves the file). Returns the
        original bytes if Pillow isn't installed, the payload isn't a
        supported raster image, or the image is already within budget.
        Any decode/encode failure also falls back to the original.

        Without this step a single iPhone screenshot (~1170 × 2532) plus
        any second image in the same turn would bounce off the API with
        "Start a new session with fewer images," wedging the
        conversation until the user resets it.
        """
        if not data:
            return data
        try:
            from PIL import Image, ImageOps
        except Exception:
            return data
        ct = (content_type or "").lower()
        if ct and not ct.startswith("image/"):
            return data
        # Cap the pixel budget BEFORE Image.open allocates the raster.
        # Pillow's default MAX_IMAGE_PIXELS (~89M) only raises a
        # DecompressionBombWarning (a Warning, not Exception) in the
        # 89M-178M range, so a malicious PNG could load ~300 MB into
        # RAM before the existing try/except catches anything. Tighten
        # the limit and promote the warning to an error so the outer
        # except returns the original bytes safely. 40M pixels covers
        # the largest legitimate phone screenshot (≈ 13 MP) with margin.
        import warnings
        Image.MAX_IMAGE_PIXELS = 40_000_000
        warnings.filterwarnings("error", category=Image.DecompressionBombWarning)
        try:
            import io
            src = io.BytesIO(data)
            img = Image.open(src)
            img.load()
        except Exception:
            return data
        fmt = (img.format or "").upper()
        if fmt not in {"JPEG", "PNG", "WEBP"}:
            return data
        try:
            img = ImageOps.exif_transpose(img)
        except Exception:
            pass
        w, h = img.size
        max_edge = 1568
        if max(w, h) <= max_edge:
            return data
        try:
            img.thumbnail((max_edge, max_edge), Image.LANCZOS)
            out = io.BytesIO()
            if fmt == "JPEG":
                if img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                img.save(out, format="JPEG", quality=85, optimize=True)
            elif fmt == "PNG":
                img.save(out, format="PNG", optimize=True)
            else:
                img.save(out, format="WEBP", quality=85, method=6)
            return out.getvalue()
        except Exception:
            return data

    # ── Pages ────────────────────────────────────────────────────────────

    # Per-process build identifier — changes on every bridge restart, so the
    # URL Safari sees for the chat page is different from any cached one.
    # iOS Safari's PWA "start_url" cache treats `/` as the offline-able root
    # and refuses to invalidate it even with no-store; forcing a redirect
    # to /c?b=<startup> bypasses that by giving Safari a URL it has never
    # cached after each bridge restart.
    _BUILD_ID = str(int(time.time()))

    @app.get("/", response_class=HTMLResponse)
    async def index(
        request: Request,
        crc_auth: str | None = Cookie(default=None, alias=AUTH_COOKIE),
    ):
        # iOS app hand-off: when the Capacitor wrapper navigates the
        # WebView to <bridge>/?jwt=<token>, we validate the token (same
        # HMAC format as the cookie), set the cookie, and redirect to a
        # clean URL so the JWT doesn't sit in the address bar / history.
        jwt_param = request.query_params.get("jwt")
        if jwt_param and _is_authed(jwt_param):
            resp = RedirectResponse(url=f"/c?b={_BUILD_ID}", status_code=302)
            resp.set_cookie(
                key=AUTH_COOKIE,
                value=jwt_param,
                max_age=BEARER_MAX_AGE,
                httponly=True,
                samesite="lax",
                secure=cfg.web_cookie_secure,
            )
            return resp
        if not _is_authed(crc_auth):
            return RedirectResponse(url="/login", status_code=302)
        # Honor a caller-supplied ?fresh=<token> as the chat-URL build stamp
        # so recovery flows (e.g. /refresh → meta-refresh /?fresh=<ts>) end
        # on a URL Safari has never seen — critical when Safari has flagged
        # the previous /c?b=<_BUILD_ID> URL with "A problem repeatedly
        # occurred" and refuses to load it again. Without this, /refresh
        # bounces the user right back to the blacklisted URL because both
        # navigations share `_BUILD_ID` (frozen at module import).
        fresh = request.query_params.get("fresh")
        # Whitelist: digits-only, max 16 chars. Stops a malicious caller
        # from injecting a redirect to an off-host URL via path-traversal
        # or a `b=` value containing `&` / `#`.
        if fresh and fresh.isdigit() and len(fresh) <= 16:
            return RedirectResponse(url=f"/c?b=r{fresh}", status_code=302)
        return RedirectResponse(url=f"/c?b={_BUILD_ID}", status_code=302)

    def _render_html(name: str) -> HTMLResponse:
        """Read a static HTML file and substitute the `__ASSET_VERSION__`
        placeholder with the current mtime-derived asset version. The
        `?v=__ASSET_VERSION__` query strings in index.html / login.html
        always carry whatever version the bridge currently considers
        current — guaranteed in sync with the hello frame and
        runtime-config.js. No manual bumping per build."""
        raw = (_STATIC_DIR / name).read_text(encoding="utf-8")
        html = raw.replace("__ASSET_VERSION__", _get_asset_version())
        return HTMLResponse(content=html, headers=_HTML_NO_CACHE)

    @app.get("/c", response_class=HTMLResponse)
    async def chat(crc_auth: str | None = Cookie(default=None, alias=AUTH_COOKIE)):
        if not _is_authed(crc_auth):
            return RedirectResponse(url="/login", status_code=302)
        return _render_html("index.html")

    @app.get("/login", response_class=HTMLResponse)
    async def login_page(crc_auth: str | None = Cookie(default=None, alias=AUTH_COOKIE)):
        if _is_authed(crc_auth):
            return RedirectResponse(url="/", status_code=302)
        return _render_html("login.html")

    @app.post("/login")
    async def login_submit(request: Request, password: str = Form(...)):
        client_ip = request.client.host if request.client else "?"
        if not _rate_limit_ok(client_ip):
            # Extra delay on top of the 429 so a script can't tight-loop.
            await asyncio.sleep(1.0)
            return JSONResponse(
                {"ok": False, "error": "Too many attempts — wait a minute."},
                status_code=429,
            )
        if not secrets.compare_digest(password.strip(), cfg.web_password):
            # Record the failure for the rate limiter (only failures count
            # against the budget — see _rate_limit_record_failure).
            _rate_limit_record_failure(client_ip)
            # Small delay to discourage online brute force on short passwords.
            await asyncio.sleep(0.5)
            return JSONResponse(
                {"ok": False, "error": "Invalid password."},
                status_code=401,
            )
        # On success, hand back a self-validating HMAC cookie — NOT the
        # password itself. So a cookie leak can't be replayed past the 30-day
        # expiry and can't be used to recover the password.
        resp = JSONResponse({"ok": True})
        resp.set_cookie(
            key=AUTH_COOKIE,
            value=_mint_session_cookie(cfg.web_password),
            max_age=COOKIE_MAX_AGE,
            httponly=True,
            samesite="lax",
            # Default false so it works over http on the Tailscale local IP.
            # Set CRC_COOKIE_SECURE=1 when you put cloudflared/https in front
            # so the cookie isn't accepted on plain http.
            secure=cfg.web_cookie_secure,
        )
        return resp

    # ── Mobile-app pairing (iOS Capacitor companion) ─────────────────────
    #
    # Same single-user, password-on-the-laptop model as the PWA. The
    # difference is the wire shape: instead of Set-Cookie, the iOS app
    # gets the same HMAC token in the response body and presents it as
    # `Authorization: Bearer <token>`. Format and verification are
    # identical (_verify_session_cookie); the cookie path stays untouched.
    #
    # CORS: these endpoints intentionally allow `*` origin so the iOS
    # app's WebView (cross-origin to the bridge) can call them. Safe
    # because:
    #   - Auth is via password-in-body or Bearer-in-header, never cookies
    #   - Allow-Credentials is NOT sent, so browsers won't attach the
    #     PWA's cookie even if the iOS app's WebView shares a jar
    #   - The PWA's CSRF defense (X-CRC-Request + cookie auth on /login)
    #     is unaffected — those endpoints have no CORS headers
    _MOBILE_CORS_HEADERS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-CRC-Request",
        "Access-Control-Max-Age": "86400",
    }

    def _mobile_cors(resp: Response) -> Response:
        for k, v in _MOBILE_CORS_HEADERS.items():
            resp.headers[k] = v
        return resp

    # CORS preflight for every endpoint the iOS app calls. FastAPI doesn't
    # auto-handle OPTIONS for endpoints we declared as POST/GET only.
    @app.options("/api/pair")
    @app.options("/api/devices/register")
    @app.options("/api/state")
    async def _mobile_cors_preflight() -> Response:
        return _mobile_cors(Response(status_code=204))

    # Re-decorated /api/state below — see the top of the existing handler
    # for the source. We *also* attach CORS headers there so the iOS app's
    # cross-origin GET succeeds. (Same-origin PWA calls ignore CORS.)

    @app.post("/api/pair")
    async def api_pair(request: Request, body: dict[str, Any] = Body(...)) -> Response:
        client_ip = request.client.host if request.client else "?"
        if not _rate_limit_ok(client_ip, bucket=pair_attempts):
            await asyncio.sleep(1.0)
            return _mobile_cors(JSONResponse(
                {"ok": False, "error": "Too many attempts — wait a minute."},
                status_code=429,
            ))
        password = (body.get("password") or "").strip()
        device_id = (body.get("device_id") or "").strip()
        device_label = (body.get("device_label") or "iOS device").strip()[:64]
        if not password or not device_id:
            return _mobile_cors(JSONResponse(
                {"ok": False, "error": "Missing password or device_id."},
                status_code=400,
            ))
        if not secrets.compare_digest(password, cfg.web_password):
            _rate_limit_record_failure(client_ip, bucket=pair_attempts)
            await asyncio.sleep(0.5)
            return _mobile_cors(JSONResponse(
                {"ok": False, "error": "Invalid password."},
                status_code=401,
            ))
        token = _mint_session_cookie(cfg.web_password, ttl_s=BEARER_MAX_AGE)
        # Stash the registration so a future "list paired devices" endpoint
        # has something to show. In-memory: we re-pair on every iOS launch
        # anyway, and persistence brings its own headaches (file locking,
        # corruption, GDPR). Restart-reset is fine here.
        mobile_devices[device_id] = {
            "label": device_label,
            "paired_at": int(time.time()),
            "expires_at": int(time.time()) + BEARER_MAX_AGE,
            "client_ip": client_ip,
        }
        log.info("iOS pair: device=%s ip=%s label=%r", device_id, client_ip, device_label)
        return _mobile_cors(JSONResponse({
            "ok": True,
            "jwt": token,
            "expires_at": int(time.time()) + BEARER_MAX_AGE,
            "device_id": device_id,
        }))

    @app.post("/api/devices/register")
    async def api_devices_register(
        request: Request,
        body: dict[str, Any] = Body(...),
        _: None = Depends(require_auth),
    ) -> Response:
        apns_token = (body.get("apns_token") or "").strip()
        platform = (body.get("platform") or "ios").strip().lower()
        if not apns_token or platform not in {"ios", "android"}:
            return _mobile_cors(JSONResponse(
                {"ok": False, "error": "Missing apns_token or bad platform."},
                status_code=400,
            ))
        # APNs / FCM push send is a separate piece of work; for now we just
        # log the registration so the iOS app's pair flow completes cleanly.
        # When push send lands, the registry lives in a new bridge/push_apns.py
        # module and reads from here.
        log.info("Push token registered: platform=%s ip=%s len=%d",
                 platform,
                 request.client.host if request.client else "?",
                 len(apns_token))
        return _mobile_cors(JSONResponse({"ok": True}))

    # ── Passkeys (Face ID / Touch ID) ─────────────────────────────────────

    # Initialise the passkey manager only if the bridge knows its public
    # HTTPS URL — WebAuthn requires a secure context and a stable RP ID.
    passkey_mgr: PasskeyManager | None = None
    if cfg.web_https_url:
        try:
            parsed = urlparse(cfg.web_https_url)
            rp_id = parsed.hostname or ""
            origin = f"{parsed.scheme}://{parsed.hostname}"
            if parsed.port:
                origin += f":{parsed.port}"
            passkey_mgr = PasskeyManager(
                store_path=cfg.projects_root / ".crc-passkeys.json",
                rp_id=rp_id,
                rp_name="Bridgy",
                origin=origin,
            )
        except Exception:
            log.exception("Failed to init passkey manager; Face ID disabled")

    # Web Push: auto-generate VAPID keys on first run and persist them
    # next to passkeys under projects_root. Used to ping the phone when
    # Claude finishes a task even while the PWA is fully closed.
    try:
        push_mgr = build_push_manager(cfg.projects_root, vapid_email=cfg.web_push_email)
        # Reap subscriptions older than 30 days on boot. The label-dedup
        # in add_subscription handles the common case (re-subscribe
        # replaces), but a phone the user never reinstalls would leave
        # an aging endpoint behind forever — Apple keeps returning 201
        # for dead endpoints, so age is the only reliable signal.
        try:
            removed = push_mgr.purge_stale()
            if removed:
                log.info("Pruned %d stale push subscription(s) at boot.", removed)
        except Exception:
            log.exception("purge_stale raised at boot; non-fatal")
    except Exception:
        log.exception("Failed to init push manager; Web Push disabled")
        push_mgr = None

    @app.get("/api/push/vapid-public-key")
    async def push_vapid_public_key(_: None = Depends(require_auth)):
        if push_mgr is None:
            raise HTTPException(503, "Push disabled (init failed)")
        return {"key": push_mgr.vapid_public_key}

    @app.post("/api/push/subscribe")
    async def push_subscribe(
        request: Request,
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        if push_mgr is None:
            raise HTTPException(503, "Push disabled (init failed)")
        body = await request.json()
        sub = body.get("subscription")
        label = (body.get("label") or "")[:60]
        if not isinstance(sub, dict) or not sub.get("endpoint"):
            raise HTTPException(400, "Missing subscription")
        push_mgr.add_subscription(sub, label=label)
        return {"ok": True}

    @app.post("/api/push/unsubscribe")
    async def push_unsubscribe(
        request: Request,
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        if push_mgr is None:
            return {"ok": True}
        body = await request.json()
        endpoint = (body.get("endpoint") or "").strip()
        if endpoint:
            push_mgr.remove_subscription(endpoint)
        return {"ok": True}

    # ─── OS-trigger endpoint ─────────────────────────────────────────
    # Local-only "spawn a claude run" endpoint. Token-authed (NOT cookie)
    # so Windows Task Scheduler / cron / launchd entries can POST without
    # holding a browser session. Claude self-schedules check-ins by
    # writing OS-scheduler entries that hit this URL — see the system
    # prompt addendum in bridge/runner.py.

    class _TriggerSink:
        """Minimal RunSink used by /api/trigger spawns. Collects the
        assistant's trailing text into a 200-char summary buffer for the
        push body, drops most other events on the floor (the jsonl on
        disk is the durable record). Fires push_mgr.send on a clean
        outcome=done so the user gets a notification even though no PWA
        is connected."""
        def __init__(self, project: str, tab_id: str, label: str) -> None:
            self._project = project
            self._tab_id = tab_id
            self._label = label
            self._text_buf: str = ""

        async def run_started(self, *, project: str, run_id: int) -> None: pass
        async def send_text(self, text: str, *, tag: str | None = None) -> None: pass
        async def send_media(self, path: Path, *, tag: str) -> None: pass

        async def emit_delta(self, text: str) -> None:
            if not text: return
            if len(self._text_buf) < 5000:
                self._text_buf = (self._text_buf + text)[:5000]

        async def emit_tool_use(self, *, name: str, input_data: dict[str, Any], tool_use_id: str = "") -> None:
            # Reset trailing text on each tool call so summary captures
            # post-final-tool prose, matching WebSink's summary heuristic.
            self._text_buf = ""

        async def emit_tool_error(self, *, text: str, tool_use_id: str = "") -> None: pass
        async def emit_tool_result(self, *, tool_use_id: str, text: str, is_error: bool) -> None: pass
        async def emit_session_init(self, *, session_id: str, model: str = "") -> None: pass
        async def emit_usage(self, **kwargs: Any) -> None: pass
        async def emit_final(self) -> None: pass

        async def run_finished(
            self,
            *,
            project: str,
            run_id: int,
            outcome: str,
            detail: str = "",
            notify: bool = True,
        ) -> None:
            if push_mgr is None or not push_mgr.has_subscriptions():
                return
            if outcome != "done" or not notify:
                return
            raw = (self._text_buf or "").strip()
            first_para = raw.split("\n\n", 1)[0].strip()
            first_para = " ".join(first_para.split())
            summary = first_para[:200] if first_para else "Trigger run finished"
            url = "/c?" + "&".join([
                f"tab={quote(self._tab_id, safe='')}",
                f"project={quote(project, safe='')}",
            ])
            title = f"[{self._label or project}]"
            try:
                await push_mgr.send(title=title, body=summary, url=url, tag="")
            except Exception:
                log.exception("trigger push send failed")

        def keepalive_task(self) -> Any:
            return None

    @app.post("/api/trigger/{token}")
    async def api_trigger(token: str, request: Request):
        """Loopback-only spawn endpoint. Token-authed AND IP-gated; ignores cookies.

        Caller must be on 127.0.0.1 / ::1 — the bridge binds to 0.0.0.0
        for the WS+UI traffic, but this endpoint is the on-laptop OS
        scheduler hook (schtasks / cron / launchd) and never needs to be
        reachable from a tailnet peer. Restricting it to loopback shrinks
        the token's attack surface to "anyone who can already run code on
        this laptop," which is already the trust boundary.

        Body (JSON): {
          project, prompt,
          tab_id?,         # default: continue the project's most recent tab
                           # ("scheduler-style" continuation). Pass an explicit
                           # tab_id to fork into its own thread (test triggers,
                           # one-off announcements).
          permission_mode?, model?, label?,
          force_new_tab?,  # boolean. True forces a fresh `trigger-<ts>` tab.
        }
        On success: {ok: true, tab_id, resumed: bool}. On token mismatch: 401.

        Default behaviour (no tab_id, no force_new_tab): pick the most recent
        active session for this project from the SessionManager. The trigger
        resumes that conversation — letting Claude pick up where it left off
        instead of opening yet another chat for every cron fire. Forced new
        tabs are still available for test runs or "fire and forget" pings.

        Concurrency capped by SessionManager._run_semaphore alongside
        normal user-driven runs.
        """
        client_host = (request.client.host if request.client else "") or ""
        if client_host not in {"127.0.0.1", "::1", "localhost"}:
            # Don't leak whether the token exists for off-host callers.
            raise HTTPException(404, "Not Found")
        if not hmac.compare_digest(token, cfg.trigger_token):
            raise HTTPException(401, "Invalid trigger token")
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(400, "Body must be JSON")
        project = (body.get("project") or "").strip()
        prompt = (body.get("prompt") or "").strip()
        if not project or not prompt:
            raise HTTPException(400, "project and prompt are required")
        permission_mode = (body.get("permission_mode") or "auto").strip()
        if permission_mode not in {"auto", "plan", "edits", "ask"}:
            raise HTTPException(400, "Invalid permission_mode")
        model = (body.get("model") or "").strip()
        label = (body.get("label") or "")[:60]
        force_new_tab = bool(body.get("force_new_tab"))
        explicit_tab_id = (body.get("tab_id") or "").strip()
        resumed = False
        if explicit_tab_id:
            tab_id = explicit_tab_id
            # If caller named an existing session, this resumes it via
            # the SessionManager's captured session_id.
            resumed = sessions.sessions.get(tab_id) is not None
        elif force_new_tab:
            tab_id = f"trigger-{int(time.time())}"
        else:
            # Default: find the most recent tab for this project and
            # resume it. Falls back to a fresh trigger-* tab if no
            # session exists yet.
            candidates = [
                s for s in sessions.sessions.values()
                if s.project == project and s.session_id is not None
            ]
            if candidates:
                # No "last touched" timestamp on Session today — pick the
                # tab whose current run is None and whose session_id is
                # set (most-recent COMPLETED). If multiple match, fall
                # back to whichever has the highest next_run_id (proxy
                # for "had more activity"). Deterministic enough for now.
                candidates.sort(key=lambda s: (s.current is not None, -s.next_run_id))
                tab_id = candidates[0].tab_id
                resumed = True
            else:
                tab_id = f"trigger-{int(time.time())}"
        try:
            cwd = resolve_project(state.active_root, project)
        except ProjectNotFound as e:
            raise HTTPException(400, str(e))
        sink = _TriggerSink(project=project, tab_id=tab_id, label=label)
        asyncio.create_task(sessions.run(
            tab_id=tab_id,
            project=project,
            cwd=cwd,
            prompt=prompt,
            permission_mode=permission_mode,
            sink=sink,
            effort=None,
            model_override=model or None,
        ), name=f"trigger-{tab_id}")
        return {"ok": True, "tab_id": tab_id, "resumed": resumed}

    async def _push_notify_run_finished(
        project: str,
        _outcome: str,
        tab_id: str = "",
        summary: str = "",
        session_id: str = "",
    ) -> None:
        """Hook handed to each WebSink; fans out Web Push to subscribers
        whenever a run completes successfully. `tab_id` is woven into the
        deep-link URL so tapping the notification reopens the EXACT tab
        the run finished in — not whichever tab happens to be active.
        `session_id` is the claude session UUID, also embedded in the URL
        so a tap on a HOURS-OLD banner still resumes the right
        conversation even after the originating tab has been closed
        locally (multi-hour banners outlive in-memory tab state).
        `summary` is the trailing 1-2 sentences the assistant wrote after
        its last tool call — surfaced as the banner body so the user can
        glance at the lock screen and know which run completed."""
        if push_mgr is None or not push_mgr.has_subscriptions():
            return
        params: list[str] = []
        if tab_id:
            params.append(f"tab={quote(tab_id, safe='')}")
        if project:
            params.append(f"project={quote(project, safe='')}")
        if session_id:
            params.append(f"session={quote(session_id, safe='')}")
        url = "/c" + (("?" + "&".join(params)) if params else "")
        # Title strategy: iOS Web Push banners ALWAYS render the manifest
        # `name` ("Bridgy") + a "from <appname>" attribution line
        # underneath — there's no API to suppress that. So we put the
        # per-run info in the TITLE position (`[project] summary`) where
        # iOS bolds it above the body, and trust iOS to handle the
        # "Bridgy" branding line itself.
        summary_clean = (summary or "Run finished").strip()
        # Title = bracketed project name, body = short one-line summary.
        # Layout on iOS:
        #   Bridgy · now                 (iOS app-source line)
        #   [bridgy]  (our title, bold)
        #   short summary                (our body, ~80 chars one line)
        # Using the project as the title gives iOS a content-bearing
        # heading distinct from the manifest name, so the banner has
        # three lines of useful info without duplication.
        title = f"[{project}]" if project else "Run done"
        # No additional truncation here — sink.py already returned a
        # complete first sentence (or "Run finished" fallback). Adding
        # an ellipsis cap here would re-introduce the mid-thought cuts.
        body = summary_clean
        try:
            await push_mgr.send(
                title=title,
                body=body,
                url=url,
                tag="",
            )
        except Exception:
            log.exception("Web Push send failed")

    @app.get("/api/passkey/status")
    async def passkey_status():
        """Tells the login page whether Face ID is even an option (HTTPS
        configured + at least one passkey registered). No auth required —
        it's just feature detection."""
        return {
            "available": passkey_mgr is not None,
            "has_credentials": bool(passkey_mgr and passkey_mgr.has_credentials()),
        }

    @app.post("/api/passkey/register/start")
    async def passkey_register_start(
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        if passkey_mgr is None:
            raise HTTPException(400, "Passkey support not configured (set CRC_HTTPS_URL).")
        return passkey_mgr.begin_registration()

    @app.post("/api/passkey/register/finish")
    async def passkey_register_finish(
        request: Request,
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        if passkey_mgr is None:
            raise HTTPException(400, "Passkey support not configured.")
        body = await request.json()
        label = (body.get("label") or "Device").strip()[:64]
        response_json = body.get("credential")
        if not isinstance(response_json, dict):
            raise HTTPException(400, "Missing credential")
        try:
            result = passkey_mgr.finish_registration(response_json=response_json, label=label)
        except Exception as e:
            log.exception("Passkey registration failed")
            raise HTTPException(400, f"Registration failed: {e}")
        return result

    @app.post("/api/passkey/auth/start")
    async def passkey_auth_start(request: Request):
        # No auth required — this IS the auth.
        client_ip = request.client.host if request.client else "?"
        if not _rate_limit_ok(client_ip):
            await asyncio.sleep(1.0)
            raise HTTPException(429, "Too many attempts")
        if passkey_mgr is None or not passkey_mgr.has_credentials():
            # Symmetry with the password endpoint: count missing-passkey
            # probes against the rate limit too so an attacker can't
            # tight-loop /auth/start.
            _rate_limit_record_failure(client_ip)
            raise HTTPException(404, "No registered passkey")
        return passkey_mgr.begin_authentication()

    @app.post("/api/passkey/auth/finish")
    async def passkey_auth_finish(request: Request):
        # No auth required — this completes the auth and issues the cookie.
        client_ip = request.client.host if request.client else "?"
        if not _rate_limit_ok(client_ip):
            await asyncio.sleep(1.0)
            raise HTTPException(429, "Too many attempts")
        if passkey_mgr is None or not passkey_mgr.has_credentials():
            raise HTTPException(404, "No registered passkey")
        body = await request.json()
        response_json = body.get("credential")
        if not isinstance(response_json, dict):
            raise HTTPException(400, "Missing credential")
        try:
            passkey_mgr.finish_authentication(response_json=response_json)
        except Exception as e:
            _rate_limit_record_failure(client_ip)
            log.warning("Passkey auth failed: %s", e)
            await asyncio.sleep(0.5)
            raise HTTPException(401, "Invalid passkey")
        resp = JSONResponse({"ok": True})
        resp.set_cookie(
            key=AUTH_COOKIE, value=_mint_session_cookie(cfg.web_password),
            max_age=COOKIE_MAX_AGE, httponly=True, samesite="lax",
            secure=cfg.web_cookie_secure,
        )
        return resp

    @app.get("/api/passkey/list")
    async def passkey_list(_: None = Depends(require_auth)):
        if passkey_mgr is None:
            return {"credentials": []}
        return {"credentials": passkey_mgr.store.labels()}

    @app.post("/logout")
    async def logout(
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(AUTH_COOKIE)
        return resp

    # ── REST ─────────────────────────────────────────────────────────────

    @app.post("/api/ws-token")
    async def ws_token(
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        """Mint a session-equivalent token the client passes via the WSS
        query string. Works around iOS Safari's PWA mode not always sending
        cookies on WebSocket upgrade. Same HMAC scheme as the cookie, same
        lifetime — there is no separate "WS-only" credential, just a way
        to deliver the existing one over a more-reliable channel."""
        return {"token": _mint_session_cookie(cfg.web_password)}

    # Per-image cap (in base64 chars). 2.5MB base64 ≈ 1.8MB raw image —
    # comfortably covers iPhone screenshots (the 16 Pro Max takes them
    # at ~1.5MB PNG) AND photos taken from the camera roll. Bumped from
    # the earlier 280KB because users were closing the PWA, reopening,
    # and finding their attachments came back as "(image too large to
    # preview)" placeholders. The chat-history replay endpoint is HTTP
    # response, not a WS frame, so payload size is bounded only by the
    # browser's response-buffer limit (many MBs).
    _MAX_IMAGE_B64_CHARS = 2_500_000

    # Claude Code writes some events to the jsonl as `user` type even
    # though they're internal infrastructure (hook output, agent-task
    # completion notifications, IDE selection context, etc.). Filter
    # these patterns out of the mobile chat — they're noise that
    # would otherwise render as a coral "user message" bubble.
    _INTERNAL_USER_WRAPPER_TAGS = (
        "task-notification",
        "system-reminder",
        "command-name",
        "command-message",
        "command-args",
        "local-command-stdout",
        "local-command-stderr",
        "ide_selection",
        "user-prompt-submit-hook",
    )
    _INTERNAL_WRAPPER_RES = [
        re.compile(rf"<{tag}>.*?</{tag}>", re.DOTALL | re.IGNORECASE)
        for tag in _INTERNAL_USER_WRAPPER_TAGS
    ]
    _TASK_NOTIFICATION_RE = re.compile(
        r"<task-notification>(.*?)</task-notification>",
        re.DOTALL | re.IGNORECASE,
    )
    # Inner fields of a task-notification block. The full block holds
    # <task-id>, <tool-use-id>, <output-file>, <status>, <summary>, and
    # <result> (the agent's entire return). Dumping the whole block
    # into the chat produces a wall of XML on the mobile; instead we
    # extract <summary> (one-line completion banner) and <result> (the
    # actual report) separately so the client can render them in their
    # respective places.
    _TN_SUMMARY_RE = re.compile(r"<summary>(.*?)</summary>", re.DOTALL | re.IGNORECASE)
    _TN_RESULT_RE  = re.compile(r"<result>(.*?)</result>",  re.DOTALL | re.IGNORECASE)
    _TN_TOOLUSE_RE = re.compile(r"<tool-use-id>(.*?)</tool-use-id>", re.DOTALL | re.IGNORECASE)
    _TN_STATUS_RE  = re.compile(r"<status>(.*?)</status>", re.DOTALL | re.IGNORECASE)

    # Lines emitted by `_build_prompt` look like:
    #   "  - [image] screenshot.png → C:\\Users\\...\\.web-uploads\\xxx.png"
    # On replay we want to surface those uploads as attachment chips so the
    # original prompt's chip layout survives a close+reopen. The arrow can
    # be the unicode "→" or an ASCII "->" depending on locale (build_prompt
    # uses "→").
    _UPLOAD_REF_RE = re.compile(
        r"^\s*-\s*\[(image|file)\]\s+(.+?)\s+(?:→|->)\s+(.+?)\s*$",
        re.MULTILINE,
    )

    def _extract_uploaded_attachment_refs(text: str) -> list[dict[str, Any]]:
        """Find `- [image|file] name → path` lines in a user prompt and
        return attachment dicts for them. If the path still exists on
        disk we register a fresh /media/<token> (6h TTL) so the client
        can render an actual thumbnail. If it's missing (cleaned up by
        an older bridge version that auto-deleted uploads), we STILL
        emit a chip carrying just the name + `missing: true` — the user
        at least sees the filename greyed out instead of silently
        losing the attachment row entirely."""
        out: list[dict[str, Any]] = []
        if not text:
            return out
        for m in _UPLOAD_REF_RE.finditer(text):
            kind = m.group(1)
            name = m.group(2).strip()
            raw_path = m.group(3).strip()
            entry: dict[str, Any] = {
                "kind": "image" if kind == "image" else "file",
                "name": name,
                "thumbUrl": None,
            }
            try:
                p = Path(raw_path)
                if p.is_file():
                    url = _register_media(p)
                    if kind == "image":
                        entry["thumbUrl"] = url
                    entry["mediaUrl"] = url
                    # Hand back the absolute path + mime so the client's
                    # edit-and-resend path can resubmit this attachment
                    # without re-uploading. Without these, the resend
                    # frame had path:undefined and the server rejected it
                    # with "Attachment missing path". Path leaks no
                    # secret — the client uploaded the file in the first
                    # place; it lives inside <project>/.web-uploads/ and
                    # the prompt-validator already path-jails it there
                    # before honoring the resend.
                    entry["path"] = str(p)
                    guessed_mime, _ = mimetypes.guess_type(p.name)
                    entry["mime"] = guessed_mime or ("image/*" if kind == "image" else "application/octet-stream")
                    try:
                        entry["size"] = p.stat().st_size
                    except OSError:
                        pass
                else:
                    entry["missing"] = True
            except (OSError, ValueError):
                entry["missing"] = True
            out.append(entry)
        return out

    def _strip_internal_wrappers(text: str) -> str:
        """Remove `<task-notification>…</task-notification>` (and
        siblings) blocks from a user event's text payload. Returns
        the cleaned text — caller should check if it's empty after
        stripping and skip the event if so."""
        if not text:
            return text
        out = text
        for r in _INTERNAL_WRAPPER_RES:
            out = r.sub("", out)
        return out.strip()

    def _extract_task_notifications(text: str) -> list[dict[str, str]]:
        """Pull `<task-notification>` blocks out of a user event and
        return a structured record for each: a short `summary` line,
        the full `result` text (the agent's return value), the
        `tool_use_id` (so the client can attach the result back to
        the matching Agent toolcard), and a `status`. Returns an
        empty list if the text has no notifications. The caller
        should still run `_strip_internal_wrappers` on the same text
        to remove the wrappers from any user-visible bubble."""
        if not text:
            return []
        out: list[dict[str, str]] = []
        for m in _TASK_NOTIFICATION_RE.finditer(text):
            body = (m.group(1) or "").strip()
            if not body:
                continue
            summary = (_TN_SUMMARY_RE.search(body) or [None, ""])
            summary_txt = (summary.group(1).strip() if summary else "") if hasattr(summary, "group") else ""
            result = _TN_RESULT_RE.search(body)
            result_txt = result.group(1).strip() if result else ""
            tu = _TN_TOOLUSE_RE.search(body)
            tool_use_id = tu.group(1).strip() if tu else ""
            st = _TN_STATUS_RE.search(body)
            status = st.group(1).strip() if st else ""
            out.append({
                "summary": summary_txt,
                "result": result_txt,
                "tool_use_id": tool_use_id,
                "status": status,
            })
        return out

    def _extract_user_attachments(content) -> list[dict[str, Any]]:
        """Walk a user message's `content` list and return any image
        blocks shaped as the mobile client's attachment chips. Each
        attachment carries either a data: URL the client renders
        directly or a `truncated: true` placeholder when the original
        was too large to send."""
        out: list[dict[str, Any]] = []
        if not isinstance(content, list):
            return out
        for blk in content:
            if not isinstance(blk, dict):
                continue
            if blk.get("type") != "image":
                continue
            source = blk.get("source") or {}
            if source.get("type") != "base64":
                continue
            media_type = source.get("media_type") or "image/png"
            data = source.get("data") or ""
            if not data:
                continue
            if len(data) > _MAX_IMAGE_B64_CHARS:
                out.append({
                    "kind": "image",
                    "name": "(image too large to preview)",
                    "media_type": media_type,
                    "thumbUrl": None,
                    "size": len(data),
                    "truncated": True,
                })
            else:
                out.append({
                    "kind": "image",
                    "name": "image",
                    "media_type": media_type,
                    "thumbUrl": f"data:{media_type};base64,{data}",
                })
        return out

    def _session_label_from_jsonl(jsonl_path: Path) -> tuple[str, str]:
        """Return (ai_title, first_user_text) for a Claude session jsonl.

        `ai_title` is the Claude-generated short label (same one VSCode's
        Claude Code extension shows in its sessions list) — when present
        it's preferable to the user's first message because it's a tight
        one-line summary of the whole conversation. `first_user_text` is
        the fallback when no ai-title has been emitted yet (early-life
        sessions). One pass over the file collects both.
        """
        ai_title = ""
        first_user = ""
        try:
            with jsonl_path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    et = ev.get("type")
                    if et == "ai-title":
                        # Claude Code emits an "ai-title" event when it
                        # generates a chat label; field is `aiTitle`.
                        cand = ev.get("aiTitle") or ev.get("title") or ""
                        if isinstance(cand, str) and cand.strip():
                            ai_title = cand.strip()
                    elif et == "user" and not first_user:
                        msg_obj = ev.get("message") or {}
                        content = msg_obj.get("content") or []
                        if isinstance(content, list):
                            for blk in content:
                                if isinstance(blk, dict) and blk.get("type") == "text":
                                    t = (blk.get("text") or "").strip()
                                    if t:
                                        first_user = t
                                        break
                        elif isinstance(content, str):
                            t = content.strip()
                            if t:
                                first_user = t
                    # Early-exit once we have both signals.
                    if ai_title and first_user:
                        break
        except OSError:
            pass
        return ai_title, first_user

    def _sessions_for_cwd(cwd: Path) -> list[dict[str, Any]]:
        """List Claude saved sessions for one project cwd. Sessions live at
        ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl. Folder-name
        encoding (non-alphanumeric → `-`) is implemented once in
        `jsonl_helpers.find_session_dir`; this function just consumes it.
        """
        match = find_session_dir(cwd)
        if match is None:
            return []
        out: list[dict[str, Any]] = []
        sorted_files = sorted(match.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
        for i, f in enumerate(sorted_files):
            if f.suffix != ".jsonl":
                continue
            ai_title, first_user = _session_label_from_jsonl(f)
            label = ai_title or first_user or "(no user message)"
            out.append({
                "session_id": f.stem,
                "preview": label[:140],
                "ai_title": ai_title,
                "first_user": first_user[:140],
                "modified_at": int(f.stat().st_mtime),
                # The first session by mtime is the most recently
                # active one; mobile marks it visually so the user
                # knows which row matches their live VSCode chat.
                "is_most_recent": i == 0,
            })
        return out

    @app.get("/api/sessions/{project}")
    async def api_sessions(project: str, _: None = Depends(require_auth)):
        """List Claude's saved sessions for this project so the user can
        resume any of them as a new tab."""
        try:
            cwd = resolve_project(state.active_root,project)
        except ProjectNotFound as e:
            raise HTTPException(404, str(e))
        return {"sessions": _sessions_for_cwd(cwd)[:50]}

    @app.get("/api/sessions")
    async def api_sessions_all(_: None = Depends(require_auth)):
        """Aggregate sessions across every project under PROJECTS_ROOT, so
        the hamburger sidebar can show one mixed timeline like the VS Code
        Claude Code extension does. Each row carries its `project` so the
        client knows where to spawn the resumed tab. Sorted by recency
        across all projects; capped to keep the wire payload manageable."""
        rows: list[dict[str, Any]] = []
        for project_name in list_projects(state.active_root):
            try:
                cwd = resolve_project(state.active_root,project_name)
            except ProjectNotFound:
                continue
            for s in _sessions_for_cwd(cwd):
                rows.append({**s, "project": project_name})
        rows.sort(key=lambda r: r["modified_at"], reverse=True)
        return {"sessions": rows[:100]}

    @app.post("/api/sessions/{project}/{session_id}/compact_inplace")
    async def api_session_compact_inplace(
        project: str,
        session_id: str,
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        """In-place compact, matching what VS Code's /compact does.

        Verified against real `~/.claude/projects/<...>/UUID.jsonl` files
        on 2026-05-14: when the user types `/compact` in VS Code, claude.exe
        writes TWO consecutive events into the SAME jsonl (same sessionId
        before and after):

        1. A system event marking the boundary:
           ```
           {"type":"system","subtype":"compact_boundary",
            "compactMetadata":{"trigger":"manual","preTokens":N,
                                "postTokens":M,"durationMs":T},
            "logicalParentUuid":"<prior event uuid>",
            "parentUuid":null, ...}
           ```
        2. A `user` event carrying the summary text, parented to the
           boundary, flagged `isCompactSummary: true` +
           `isVisibleInTranscriptOnly: true`. claude.exe's --resume
           parser walks the parent chain from the latest event back —
           seeing the boundary, it stops including pre-boundary events
           in the model's context. The synthetic user message becomes
           the new conversation seed.

        This endpoint replicates both events. Same session UUID stays
        in use. Real context reduction. The summary text is whatever
        the bridge already produced from the natural-language summary
        prompt — the client passes the most recent assistant message
        text from the chat as the summary body.
        """
        # Validate session UUID shape (matches deletes/messages).
        uuid_re = _SESSION_ID_RE
        if not uuid_re.fullmatch(session_id):
            raise HTTPException(400, f"Invalid session_id: {session_id!r}")
        try:
            cwd = resolve_project(state.active_root, project)
        except ProjectNotFound as e:
            raise HTTPException(404, str(e))
        folder = find_session_dir(cwd)
        if folder is None:
            raise HTTPException(404, "No session folder for project")
        jsonl_path = folder / f"{session_id}.jsonl"
        if not jsonl_path.is_file():
            raise HTTPException(404, "Session not found")

        # Guard against the double-POST race: phone double-tap, Safari
        # retry on a slow upload, etc. Without this both calls would read
        # the same last_assistant_uuid and append two boundary+seed
        # pairs, then count_session_context's char reset would fire twice
        # on the donut.
        async with _compact_lock_for(session_id):
            def _scan_for_last_assistant() -> tuple[str | None, str, dict[str, str]]:
                """Sync helper: walks the jsonl once and returns
                (last_assistant_uuid, last_assistant_text, meta)."""
                _last_uuid: str | None = None
                _last_text = ""
                _meta = {
                    "version": "2.1.123",
                    "gitBranch": "HEAD",
                    "slug": "",
                    "userType": "external",
                }
                with jsonl_path.open("r", encoding="utf-8") as fh:
                    for line in fh:
                        try:
                            ev = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        for k in ("version", "gitBranch", "slug", "userType"):
                            if isinstance(ev.get(k), str):
                                _meta[k] = ev[k]
                        if ev.get("type") == "assistant":
                            u = ev.get("uuid")
                            if isinstance(u, str):
                                _last_uuid = u
                            content = (ev.get("message") or {}).get("content")
                            if isinstance(content, list):
                                parts = [
                                    (blk.get("text") or "")
                                    for blk in content
                                    if isinstance(blk, dict) and blk.get("type") == "text"
                                ]
                                joined = "".join(parts).strip()
                                if joined:
                                    _last_text = joined
                            elif isinstance(content, str) and content.strip():
                                _last_text = content
                return _last_uuid, _last_text, _meta

            try:
                last_assistant_uuid, last_assistant_text, meta = await asyncio.to_thread(_scan_for_last_assistant)
            except OSError as e:
                raise HTTPException(500, f"Couldn't read session jsonl: {e}")

            if not last_assistant_text:
                raise HTTPException(
                    400,
                    "No assistant message found in the session to compact from. "
                    "Run a summarize prompt first.",
                )
            # Trim the summary to keep the post-compact context lean — same
            # spirit as VS Code's auto-compact, which typically lands in the
            # 3-12k token range. ~10000 chars ≈ 2000 tokens.
            if len(last_assistant_text) > 10000:
                last_assistant_text = last_assistant_text[:10000] + "\n\n…[summary truncated]"

            pre_tokens = 0
            try:
                pre_tokens = await asyncio.to_thread(count_session_context, session_id, cwd)
            except Exception:
                pass

            now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            boundary_uuid = str(uuid.uuid4())
            seed_uuid = str(uuid.uuid4())
            prompt_id = str(uuid.uuid4())

            boundary_event = {
                "parentUuid": None,
                "logicalParentUuid": last_assistant_uuid,
                "isSidechain": False,
                "type": "system",
                "subtype": "compact_boundary",
                "content": "Conversation compacted",
                "isMeta": False,
                "timestamp": now_iso,
                "uuid": boundary_uuid,
                "level": "info",
                "compactMetadata": {
                    "trigger": "manual",
                    "preTokens": pre_tokens,
                    "postTokens": 0,  # filled after writing
                    "durationMs": 0,
                },
                "userType": meta["userType"],
                "entrypoint": "claude-bridge",
                "cwd": str(cwd),
                "sessionId": session_id,
                "version": meta["version"],
                "gitBranch": meta["gitBranch"],
                "slug": meta["slug"],
            }
            seed_text = (
                "This session is being continued from a previous conversation "
                "that ran out of context. The summary below covers the earlier "
                "portion of our work:\n\n"
                + last_assistant_text
                + "\n\nContinue the conversation from where it left off."
            )
            seed_event = {
                "parentUuid": boundary_uuid,
                "isSidechain": False,
                "promptId": prompt_id,
                "type": "user",
                "message": {"role": "user", "content": seed_text},
                "isVisibleInTranscriptOnly": True,
                "isCompactSummary": True,
                "uuid": seed_uuid,
                "timestamp": now_iso,
                "userType": meta["userType"],
                "entrypoint": "claude-bridge",
                "cwd": str(cwd),
                "sessionId": session_id,
                "version": meta["version"],
                "gitBranch": meta["gitBranch"],
                "slug": meta["slug"],
            }
            def _append_events() -> None:
                with jsonl_path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(boundary_event, ensure_ascii=False) + "\n")
                    fh.write(json.dumps(seed_event, ensure_ascii=False) + "\n")

            try:
                await asyncio.to_thread(_append_events)
            except OSError as e:
                raise HTTPException(500, f"Couldn't append compact events: {e}")

            # Recompute context now that the boundary is in place — should
            # drop to just the summary's char count.
            try:
                post_tokens = await asyncio.to_thread(count_session_context, session_id, cwd)
            except Exception:
                post_tokens = 0
            return {
                "ok": True,
                "context_used": post_tokens,
                "pre_tokens": pre_tokens,
            }

    @app.get("/api/sessions/{project}/{session_id}/messages")
    async def api_session_messages(
        project: str,
        session_id: str,
        request: Request,
        _: None = Depends(require_auth),
    ):
        """Return the message timeline for a past Claude session so the
        web client can replay it into a chatpane when the user resumes
        from the history drawer.

        Reads the `.jsonl` file at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`
        and projects it down to a compact list of events the UI knows how
        to render:
          - user messages (text)
          - assistant text blocks
          - tool_use calls (name + input)
          - tool errors

        Tool results, system events, thinking blocks etc. are dropped —
        the same shape the live stream-json pump exposes via the WebSink.
        """
        if not _SESSION_ID_RE.match(session_id):
            raise HTTPException(400, "Invalid session_id")
        try:
            cwd = resolve_project(state.active_root,project)
        except ProjectNotFound as e:
            raise HTTPException(404, str(e))

        # When the live run sees Read/Write on an image, the bridge emits
        # a `media` WS frame so the phone renders the image inline. Those
        # frames are transient (not in the jsonl), so on replay (closing
        # and reopening the chat) the image disappears. This helper
        # mirrors that live behavior for the replay path: every tool_use
        # we surface to the client also gets a synthetic media event if
        # the file is an image inside cwd. `_INLINE_IMAGE_EXTS` is the
        # same frozenset the live path uses (imported from sessions.py)
        # so the two stay in sync.
        def _inline_media_events_for_tool(name: str, input_data: Any) -> list[dict[str, Any]]:
            if name not in ("Read", "Write"):
                return []
            if not isinstance(input_data, dict):
                return []
            file_path = input_data.get("file_path") or input_data.get("path")
            if not isinstance(file_path, str) or not file_path:
                return []
            ext = Path(file_path).suffix.lower()
            if ext not in _INLINE_IMAGE_EXTS:
                return []
            try:
                p = Path(file_path)
                if not p.is_absolute():
                    p = (cwd / file_path).resolve()
                else:
                    p = p.resolve()
                p.relative_to(cwd.resolve())
            except (OSError, ValueError):
                return []
            if not p.is_file():
                return []
            # Skip `.web-uploads/` — user uploads already render as a chip
            # on the user's own bubble; re-rendering as inline media under
            # claude's tool_use card duplicates the same image.
            try:
                parts = p.relative_to(cwd.resolve()).parts
                if parts and parts[0] == ".web-uploads":
                    return []
            except ValueError:
                pass
            try:
                url = _register_media(p)
            except Exception:
                return []
            mime = mimetypes.guess_type(str(p))[0] or "application/octet-stream"
            return [{"type": "media", "name": p.name, "url": url, "kind": "image", "mime": mime}]

        match = find_session_dir(cwd)
        if match is None:
            raise HTTPException(404, "No session folder for project")
        f = match / f"{session_id}.jsonl"
        if not f.is_file():
            raise HTTPException(404, "Session not found")
        # Incremental polling: if the client passes `?since=<offset>`,
        # only emit events that were appended after that byte position.
        # Used by the mobile client to detect when VSCode (or any other
        # Claude Code process) has written new content to the same
        # jsonl. We return the file's current size as `tail_offset` so
        # the next poll picks up where this one left off. Empty body
        # with the same tail_offset means "nothing new yet."
        try:
            since_offset = int(request.query_params.get("since", "0"))
        except ValueError:
            since_offset = 0
        # If the user explicitly paused (stopped) this session, suppress
        # only INCREMENTAL events on subsequent polls — but always
        # return the full historical message list for the INITIAL fetch
        # (since==0), otherwise reopening a paused session via the
        # history drawer renders an empty chat and the user can't see
        # their prior conversation at all. The intent of paused: don't
        # auto-replay buffered output claude.exe wrote between the user's
        # stop click and the kill landing, AND don't mirror a parallel
        # VS Code claude run on the same session. That's the polling
        # path. History fetch is fine. Cleared when the user sends a
        # fresh prompt (which IS the resume signal). We advance the
        # client's tail_offset to current EOF so when the user does
        # resume, the next poll picks up cleanly from there.
        is_paused = (project, session_id) in state.paused_sessions
        if is_paused and since_offset > 0:
            try:
                cur_size = f.stat().st_size
            except OSError:
                cur_size = 0
            return {
                "session_id": session_id,
                "events": [],
                "truncated": False,
                "usage": None,
                "tail_offset": cur_size,
                "incremental": True,
                "paused": True,
            }
        if since_offset > 0:
            try:
                cur_size = f.stat().st_size
            except OSError:
                cur_size = 0
            if cur_size <= since_offset:
                # No new content since last poll.
                return {
                    "session_id": session_id,
                    "events": [],
                    "truncated": False,
                    "usage": None,
                    "tail_offset": cur_size,
                    "incremental": True,
                }
            # File has grown. Read new lines from since_offset to EOF,
            # parse only display-relevant blocks, return them so the
            # client can append to the open tab in real time.
            new_events: list[dict[str, Any]] = []
            new_offset = since_offset
            MAX_TEXT_INC = 8000
            def _clip_inc(s: str) -> str:
                if len(s) > MAX_TEXT_INC:
                    return s[:MAX_TEXT_INC] + f"\n\n…(truncated: {len(s) - MAX_TEXT_INC} more chars)"
                return s
            try:
                with f.open("r", encoding="utf-8") as fh:
                    fh.seek(since_offset)
                    for line in fh:
                        try:
                            ev = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        et = ev.get("type")
                        # Compact boundary written by VSCode's /compact (or
                        # the bridge's compact_inplace endpoint). Surface a
                        # synthetic `compact_complete` event so the observing
                        # mobile client can render the "Conversation
                        # compacted" divider — same UX as a mobile-driven
                        # /compact, just driven by an external Claude Code
                        # process.
                        if et == "system" and ev.get("subtype") == "compact_boundary":
                            new_events.append({"type": "compact_complete"})
                            continue
                        if et == "user" and ev.get("isCompactSummary"):
                            # The summary message itself is the post-compact
                            # context seed; don't render it as a user bubble.
                            # The boundary event before it already triggered
                            # the divider; skip the summary entirely.
                            continue
                        if et == "user" and ev.get("isMeta"):
                            # Auto-injected meta prompts (the testing harness
                            # / Claude Code's "Continue from where you left
                            # off." pings) — the human didn't type these
                            # and they shouldn't appear in the chat
                            # transcript. Skip the user event AND the
                            # matching assistant response if it's the stock
                            # "No response requested." reply.
                            continue
                        if et == "assistant":
                            # Strip stock "No response requested." replies
                            # (the assistant's standard response to the
                            # auto-injected meta prompts above). These
                            # show as content-less assistant bubbles on
                            # replay otherwise.
                            msg_obj_peek = ev.get("message") or {}
                            content_peek = msg_obj_peek.get("content") or []
                            if isinstance(content_peek, list):
                                only_texts = [
                                    (b.get("text") or "").strip()
                                    for b in content_peek
                                    if isinstance(b, dict) and b.get("type") == "text"
                                ]
                                non_text = [
                                    b for b in content_peek
                                    if isinstance(b, dict) and b.get("type") != "text"
                                ]
                                if (
                                    not non_text
                                    and only_texts
                                    and all(t == "No response requested." for t in only_texts)
                                ):
                                    continue
                        if et == "user":
                            msg_obj = ev.get("message") or {}
                            content = msg_obj.get("content") or []
                            text_parts: list[str] = []
                            if isinstance(content, list):
                                for blk in content:
                                    if not isinstance(blk, dict):
                                        continue
                                    btype = blk.get("type")
                                    if btype == "text":
                                        text_parts.append(blk.get("text") or "")
                                    elif btype == "tool_result":
                                        rc = blk.get("content")
                                        if isinstance(rc, list):
                                            tr_text = "\n".join(
                                                c.get("text", "") for c in rc if isinstance(c, dict)
                                            )
                                        elif isinstance(rc, str):
                                            tr_text = rc
                                        else:
                                            tr_text = ""
                                        is_err = bool(blk.get("is_error"))
                                        tu_id = blk.get("tool_use_id") or ""
                                        if is_err and tr_text:
                                            new_events.append({"type": "tool_error", "text": _clip_inc(tr_text)})
                                        if tr_text or is_err:
                                            new_events.append({
                                                "type": "tool_result",
                                                "tool_use_id": tu_id,
                                                "text": tr_text[:_TOOL_RESULT_CAP_CHARS] if tr_text else "",
                                                "is_error": is_err,
                                            })
                            elif isinstance(content, str):
                                text_parts.append(content)
                            text = "\n".join(p for p in text_parts if p).strip()
                            # `<task-notification>` blocks are Claude Code's
                            # subagent-completion banners. They arrive as
                            # user events but the user didn't actually type
                            # them — surface them as `agent_complete`
                            # events so the client can graft the result
                            # onto the matching Agent toolcard. Other
                            # internal wrappers (system-reminder, etc.)
                            # are noise and get stripped entirely.
                            for note in _extract_task_notifications(text):
                                new_events.append({
                                    "type": "agent_complete",
                                    "tool_use_id": note.get("tool_use_id") or "",
                                    "summary": _clip_inc(note.get("summary") or ""),
                                    "result": _clip_inc(note.get("result") or ""),
                                    "status": note.get("status") or "completed",
                                })
                            text = _strip_internal_wrappers(text)
                            # Pull uploaded-file refs from the preamble
                            # BEFORE we strip it — those tell us which
                            # chips to re-render so the user can see
                            # the screenshots / files they originally
                            # attached. Image base64 inside the message
                            # body is also picked up by
                            # _extract_user_attachments as a fallback.
                            upload_atts = _extract_uploaded_attachment_refs(text)
                            if "User's message:\n" in text:
                                text = text.split("User's message:\n", 1)[1].strip()
                            atts = _extract_user_attachments(content if isinstance(content, list) else [])
                            combined_atts = upload_atts + atts
                            if text or combined_atts:
                                evt = {"type": "user", "text": _clip_inc(text) if text else ""}
                                if combined_atts:
                                    evt["attachments"] = combined_atts
                                new_events.append(evt)
                        elif et == "assistant":
                            msg_obj = ev.get("message") or {}
                            for blk in (msg_obj.get("content") or []):
                                if not isinstance(blk, dict):
                                    continue
                                btype = blk.get("type")
                                if btype == "text":
                                    t = (blk.get("text") or "").strip()
                                    if t:
                                        new_events.append({"type": "assistant_text", "text": _clip_inc(t)})
                                elif btype == "tool_use":
                                    raw_in = blk.get("input") or {}
                                    if isinstance(raw_in, dict):
                                        safe_in = {k: (_clip_inc(v) if isinstance(v, str) else v) for k, v in raw_in.items()}
                                    else:
                                        safe_in = raw_in
                                    tool_name = blk.get("name") or ""
                                    new_events.append({
                                        "type": "tool_use",
                                        "name": tool_name,
                                        "input": safe_in,
                                        "tool_use_id": blk.get("id") or "",
                                    })
                                    # Re-emit inline media for images so
                                    # replay matches the live flow.
                                    new_events.extend(_inline_media_events_for_tool(tool_name, safe_in))
                        elif et == "result":
                            # Claude Code writes a single `result` event at
                            # the end of every turn. Emit a synthetic
                            # `turn_end` so the observing client can close
                            # its synthetic run + spinner cleanly instead
                            # of relying on a 6s idle timer (which flickers
                            # on/off during long tool calls).
                            #
                            # We do NOT carry a token count here — the
                            # `result.usage` block is a RUN-LEVEL AGGREGATE
                            # whose `cache_read_input_tokens` sums every
                            # tool-call iteration's cache hits (can easily
                            # exceed the 200k window). The donut already
                            # has the correct per-call value from the most
                            # recent `assistant` event's usage; don't
                            # overwrite it with an inflated aggregate.
                            new_events.append({
                                "type": "turn_end",
                                "context_used": None,
                            })
                    new_offset = fh.tell()
            except OSError as e:
                raise HTTPException(500, f"Could not read session: {e}")
            return {
                "session_id": session_id,
                "events": new_events,
                "truncated": False,
                "usage": None,
                "tail_offset": new_offset,
                "incremental": True,
            }
        # Hard caps. A multi-hour session can produce thousands of events
        # and tens of MB of text — JSON.parse + DOM construction on the
        # phone client would OOM Safari. We cap the event count and the
        # per-text length, and we START from the latest auto-compact
        # summary because everything before it is OUT of Claude's
        # active context (the model only "sees" the summary forward).
        # That's how the user gets the RECENT messages on resume, not
        # the ancient first-300-events from days ago.
        MAX_EVENTS = 300
        MAX_TEXT = 8000      # chars per single event
        MAX_TOTAL = 200_000  # chars across the whole response
        events: list[dict[str, Any]] = []
        total_chars = 0
        truncated = False
        last_usage: dict[str, Any] | None = None
        text_chars = 0
        def _clip(s: str) -> str:
            if len(s) > MAX_TEXT:
                return s[:MAX_TEXT] + f"\n\n…(truncated: {len(s) - MAX_TEXT} more chars)"
            return s
        # PASS 1: scan the entire file to (a) find the latest compact
        # summary's byte-offset (so PASS 2 can seek there), (b) sum
        # text_chars for the donut, (c) capture the latest usage object,
        # (d) remember the offsets of the last few user events before
        # the compact boundary so we can keep some recent history visible
        # on reload. text_chars resets on compact since pre-compact
        # content is no longer in Claude's active context.
        compact_offset = 0
        # Byte offset of the user event we want to start the visible
        # replay from. With no compact, this stays 0 (start from top of
        # file). With a compact, it points a handful of user turns
        # before the boundary so the user sees recent messages on
        # reload — the model itself only sees post-boundary events.
        visible_start_offset = 0
        VISIBLE_PRECOMPACT_TURNS = 6
        # Rolling list of user-event offsets since the last compact (or
        # from the start of the file if there's been no compact yet).
        recent_user_offsets: list[int] = []
        try:
            with f.open("r", encoding="utf-8") as fh:
                offset = 0
                for line in fh:
                    line_offset = offset
                    offset += len(line.encode("utf-8"))
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if ev.get("isCompactSummary"):
                        compact_offset = line_offset
                        text_chars = count_event_chars(ev)
                        if recent_user_offsets:
                            idx = max(0, len(recent_user_offsets) - VISIBLE_PRECOMPACT_TURNS)
                            visible_start_offset = recent_user_offsets[idx]
                        recent_user_offsets = []
                        continue
                    et = ev.get("type")
                    if et == "user" and not ev.get("isMeta"):
                        recent_user_offsets.append(line_offset)
                    if et in ("user", "assistant"):
                        text_chars += count_event_chars(ev)
                    if et == "assistant":
                        u = (ev.get("message") or {}).get("usage")
                        if isinstance(u, dict):
                            last_usage = u
                    # Intentionally NO `result` branch — its usage block
                    # aggregates cache reads across every tool-call
                    # iteration in the run, inflating context_used by
                    # 4-5x on long multi-step runs. Per-call values come
                    # from `assistant` events only.
        except OSError as e:
            raise HTTPException(500, f"Could not read session: {e}")
        # PASS 2: collect display events starting from a handful of user
        # turns BEFORE the latest compact boundary (or from the top of
        # the file if no compact yet). The model's own context still
        # only contains post-boundary events — claude.exe respects the
        # compact_boundary marker — but for the UI we leak a few recent
        # pre-compact turns through so the user doesn't get a near-empty
        # chat after a silent auto-compact. A coral-only divider gets
        # injected at the boundary so there's a subtle visual break.
        all_events: list[dict[str, Any]] = []
        compact_boundary_emitted = False
        try:
            with f.open("r", encoding="utf-8") as fh:
                fh.seek(visible_start_offset)
                for line_no, line in enumerate(fh):
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    et = ev.get("type")
                    # When we cross the compact boundary (the
                    # isCompactSummary user event), emit the divider
                    # marker. The summary text itself is intentionally
                    # NOT rendered — the model has it, the user shouldn't
                    # see it.
                    if ev.get("isCompactSummary"):
                        if not compact_boundary_emitted:
                            all_events.append({"type": "compact_complete"})
                            compact_boundary_emitted = True
                        continue
                    if et == "system" and ev.get("subtype") == "compact_boundary":
                        # The bridge's compact_inplace writes a separate
                        # system event right before the summary; the
                        # divider fires off the summary instead so this
                        # one would just double up.
                        continue
                    if et == "user" and ev.get("isMeta"):
                        # Auto-injected meta prompts ("Continue from where
                        # you left off." etc.) — skip on replay.
                        continue
                    if et == "assistant":
                        # Skip stock "No response requested." replies the
                        # assistant emits in response to meta prompts.
                        _content_peek = (ev.get("message") or {}).get("content") or []
                        if isinstance(_content_peek, list):
                            _texts = [
                                (b.get("text") or "").strip()
                                for b in _content_peek
                                if isinstance(b, dict) and b.get("type") == "text"
                            ]
                            _non_text = [
                                b for b in _content_peek
                                if isinstance(b, dict) and b.get("type") != "text"
                            ]
                            if (
                                not _non_text
                                and _texts
                                and all(t == "No response requested." for t in _texts)
                            ):
                                continue
                    if et == "user":
                        msg_obj = ev.get("message") or {}
                        content = msg_obj.get("content") or []
                        text_parts: list[str] = []
                        if isinstance(content, list):
                            for blk in content:
                                if not isinstance(blk, dict):
                                    continue
                                btype = blk.get("type")
                                if btype == "text":
                                    text_parts.append(blk.get("text") or "")
                                elif btype == "tool_result":
                                    rc = blk.get("content")
                                    if isinstance(rc, list):
                                        result_text = "\n".join(
                                            c.get("text", "") for c in rc if isinstance(c, dict)
                                        )
                                    elif isinstance(rc, str):
                                        result_text = rc
                                    else:
                                        result_text = ""
                                    is_error = bool(blk.get("is_error"))
                                    tu_id = blk.get("tool_use_id") or ""
                                    if is_error and result_text:
                                        clipped = _clip(result_text)
                                        all_events.append({"type": "tool_error", "text": clipped})
                                        total_chars += len(clipped)
                                    if result_text or is_error:
                                        # Cap the OUT side hard — long Read /
                                        # Bash outputs blow up the JSON payload
                                        # and choke iOS Safari's parser. Same
                                        # 4500-char cap we use for context-
                                        # tokens math.
                                        out_clipped = result_text[:_TOOL_RESULT_CAP_CHARS] if result_text else ""
                                        all_events.append({
                                            "type": "tool_result",
                                            "tool_use_id": tu_id,
                                            "text": out_clipped,
                                            "is_error": is_error,
                                        })
                                        total_chars += len(out_clipped)
                        elif isinstance(content, str):
                            text_parts.append(content)
                        text = "\n".join(p for p in text_parts if p).strip()
                        # Promote `<task-notification>` blocks to
                        # `agent_complete` events so the client can graft
                        # the result onto the matching Agent toolcard.
                        # Other internal wrappers (hook injections,
                        # system-reminder, command-*) get stripped.
                        for note in _extract_task_notifications(text):
                            summary_c = _clip(note.get("summary") or "")
                            result_c = _clip(note.get("result") or "")
                            all_events.append({
                                "type": "agent_complete",
                                "tool_use_id": note.get("tool_use_id") or "",
                                "summary": summary_c,
                                "result": result_c,
                                "status": note.get("status") or "completed",
                            })
                            total_chars += len(summary_c) + len(result_c)
                        text = _strip_internal_wrappers(text)
                        upload_atts = _extract_uploaded_attachment_refs(text)
                        if "User's message:\n" in text:
                            text = text.split("User's message:\n", 1)[1].strip()
                        atts = _extract_user_attachments(content if isinstance(content, list) else [])
                        combined_atts = upload_atts + atts
                        if text or combined_atts:
                            clipped = _clip(text) if text else ""
                            evt = {"type": "user", "text": clipped}
                            if combined_atts:
                                evt["attachments"] = combined_atts
                            all_events.append(evt)
                            total_chars += len(clipped)
                    elif et == "assistant":
                        msg_obj = ev.get("message") or {}
                        for blk in (msg_obj.get("content") or []):
                            if not isinstance(blk, dict):
                                continue
                            btype = blk.get("type")
                            if btype == "text":
                                t = (blk.get("text") or "").strip()
                                if t:
                                    clipped = _clip(t)
                                    all_events.append({"type": "assistant_text", "text": clipped})
                                    total_chars += len(clipped)
                            elif btype == "tool_use":
                                # Clip tool input strings too — a big
                                # paste in a Bash command shouldn't
                                # blow up the response either.
                                tool_input = blk.get("input") or {}
                                if isinstance(tool_input, dict):
                                    safe_input: dict[str, Any] = {}
                                    for k, v in tool_input.items():
                                        if isinstance(v, str):
                                            safe_input[k] = _clip(v)
                                            total_chars += len(safe_input[k])
                                        else:
                                            safe_input[k] = v
                                else:
                                    safe_input = tool_input
                                tool_name = blk.get("name") or ""
                                all_events.append({
                                    "type": "tool_use",
                                    "name": tool_name,
                                    "input": safe_input,
                                    "tool_use_id": blk.get("id") or "",
                                })
                                # Re-emit inline media for image
                                # Read/Write tool calls so replay shows
                                # the image just like the live run did.
                                all_events.extend(_inline_media_events_for_tool(tool_name, safe_input))
        except OSError as e:
            raise HTTPException(500, f"Could not read session: {e}")
        # Drop "edited-away" user events: when the user stopped Claude
        # mid-run, edited their message, and resent, the jsonl on disk
        # holds BOTH the original prompt AND the edited prompt as two
        # separate user events with no assistant response between them.
        # While the PWA stays open the client tears the old bubble out
        # of the DOM, so the user only sees the edited one — but on
        # reload the replay would emit both, producing two stacked
        # identical bubbles (reported 2026-05-16). Filter pass: drop
        # any user event that has NO assistant_text / tool_use between
        # it and the next user event in the list. The last user event
        # is always kept (it may legitimately be awaiting a response).
        filtered: list[dict[str, Any]] = []
        i = 0
        while i < len(all_events):
            ev = all_events[i]
            if ev.get("type") == "user":
                has_response = False
                next_user_at = -1
                for j in range(i + 1, len(all_events)):
                    t = all_events[j].get("type")
                    if t == "user":
                        next_user_at = j
                        break
                    if t in ("assistant_text", "tool_use", "agent_complete"):
                        has_response = True
                        break
                if next_user_at != -1 and not has_response:
                    # This user event was superseded by a later one
                    # with no assistant content in between → orphan.
                    i += 1
                    continue
            filtered.append(ev)
            i += 1
        all_events = filtered
        # Keep the most recent MAX_EVENTS. `truncated` flags that
        # earlier events were dropped (currently no UI uses it, but
        # it's there for a future "load more" affordance).
        if len(all_events) > MAX_EVENTS:
            truncated = True
            events = all_events[-MAX_EVENTS:]
        else:
            events = all_events
        usage_summary: dict[str, int] | None = None
        # Use the char-based estimate. The Anthropic API's per-turn
        # `usage.cache_read_input_tokens` field is unreliable as a
        # context-window meter — for Claude 4 multi-cache-block
        # sessions it can report 800k+ on a 200k model. Char-based
        # (chars / 6.4 + 1500 overhead) is approximate but bounded
        # and matches VSCode's /context within 2-3% on the sessions
        # we tested.
        context_used = int(text_chars / 6.4) + 1500 if text_chars else 0
        real_input = int((last_usage or {}).get("input_tokens", 0) or 0)
        real_cache_read = int((last_usage or {}).get("cache_read_input_tokens", 0) or 0)
        real_cache_creation = int((last_usage or {}).get("cache_creation_input_tokens", 0) or 0)
        if last_usage or context_used:
            usage_summary = {
                "input_tokens": real_input,
                "output_tokens": int((last_usage or {}).get("output_tokens", 0) or 0),
                "cache_read_tokens": real_cache_read,
                "cache_creation_tokens": real_cache_creation,
                "context_used": context_used,
            }
        # The current end-of-file byte offset — the client uses this
        # as the `since` cursor for incremental polling. Subsequent
        # calls with `?since=<tail_offset>` return only events that
        # were appended after this point, so VSCode's writes to the
        # same jsonl show up in mobile within seconds.
        try:
            tail_offset = f.stat().st_size
        except OSError:
            tail_offset = 0
        return {
            "session_id": session_id,
            "events": events,
            "truncated": truncated,
            "usage": usage_summary,
            "tail_offset": tail_offset,
            # Signal a paused state on the initial (since==0) fetch too
            # so the client can render a "Paused — send a message to
            # continue" affordance and skip starting its own poll loop.
            "paused": is_paused,
        }

    @app.post("/api/sessions/delete")
    async def api_sessions_delete(
        request: Request,
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        """Delete one or more saved Claude sessions by UUID. Body:
        `{"session_ids": ["<uuid>", ...]}`. Permanent delete:

        1. Terminate any bridge-tracked Session/AdhocRun threading that
           session_id. Without this the subprocess keeps writing to the
           jsonl after we unlink, recreating it on next bridge open.
        2. Kill any external `claude.exe` whose command line carries
           `--resume <session_id>` (covers test/probe runs spawned
           outside the bridge that the SessionManager doesn't track).
        3. Unlink the `<uuid>.jsonl` from every project's encoded folder
           under ~/.claude/projects/.

        Validates each session_id is a clean UUID-ish identifier before
        touching anything so a tampered request can't traverse out of
        the sessions root or be coerced into killing arbitrary processes.
        Reported 2026-05-16: deleted sessions kept reappearing because
        orphan claude.exe processes from earlier probe runs still owned
        them; this endpoint now scrubs the whole lifecycle.
        """
        body = await request.json()
        ids = body.get("session_ids")
        if not isinstance(ids, list) or not ids:
            raise HTTPException(400, "session_ids must be a non-empty list")
        # Defense in depth: each session_id should be a pure UUID-ish
        # identifier. Anything containing path separators, dots, or
        # whitespace is rejected outright so we can't be coerced into
        # deleting arbitrary files OR killing unrelated processes by
        # smuggling shell metacharacters into the WMI query.
        uuid_re = _SESSION_ID_RE
        for sid in ids:
            if not isinstance(sid, str) or not uuid_re.fullmatch(sid):
                raise HTTPException(400, f"Invalid session_id: {sid!r}")
        wanted = set(ids)

        # Step 1: terminate bridge-tracked sessions that own these IDs.
        terminated_tracked = 0
        for sess in list(sessions.sessions.values()):
            if sess.session_id in wanted and sess.current is not None:
                try:
                    await sessions._stop_active(sess.tab_id)
                    terminated_tracked += 1
                except Exception as e:
                    log.warning("failed to terminate tracked session %s: %s", sess.session_id, e)
            if sess.session_id in wanted:
                # Clear the captured session_id so a future message on
                # this tab spawns a fresh conversation instead of
                # `--resume`-ing the just-deleted one.
                sess.session_id = None

        # Step 2: kill orphan claude.exe processes whose argv references
        # any wanted session_id. Spawn one PowerShell that scans
        # Win32_Process.CommandLine and Stop-Process by pid. Done in
        # asyncio so we don't block the event loop.
        killed_orphans = 0
        try:
            id_list = "','".join(wanted)
            ps_cmd = (
                f"$wanted=@('{id_list}'); "
                "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | "
                "ForEach-Object { $c = $_.CommandLine; if ($c) { foreach ($w in $wanted) { "
                "if ($c -like \"*--resume*$w*\") { "
                "try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; "
                "Write-Output $_.ProcessId } catch {} } } } }"
            )
            proc = await asyncio.create_subprocess_exec(
                "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=_NO_WINDOW,
            )
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
                killed_orphans = len([ln for ln in stdout.decode("utf-8", "ignore").split() if ln.strip().isdigit()])
            except asyncio.TimeoutError:
                proc.kill()
        except Exception as e:
            log.warning("orphan-claude scan failed: %s", e)

        # Step 3: unlink the .jsonl files. Now safe because step 1+2
        # released any open handles. On Windows, unlinking a file with
        # an open handle would either fail (sharing violation) or be
        # deferred until the handle closes — which is exactly the
        # resurrection scenario we're fixing.
        home = Path.home()
        sessions_root = home / ".claude" / "projects"
        if not sessions_root.is_dir():
            return {"deleted": 0, "terminated_tracked": terminated_tracked, "killed_orphans": killed_orphans}
        deleted = 0
        for project_dir in sessions_root.iterdir():
            if not project_dir.is_dir():
                continue
            for f in project_dir.iterdir():
                if f.suffix != ".jsonl":
                    continue
                if f.stem in wanted:
                    try:
                        f.unlink()
                        deleted += 1
                    except OSError as e:
                        log.warning("failed to delete %s: %s", f, e)
        return {
            "deleted": deleted,
            "requested": len(ids),
            "terminated_tracked": terminated_tracked,
            "killed_orphans": killed_orphans,
        }

    @app.get("/api/state")
    async def api_state(_: None = Depends(require_auth)) -> Response:
        running = sessions.list_running()
        # CORS-headers via _mobile_cors so the iOS app can poll this from
        # cross-origin (Bearer-authed). Same-origin PWA calls ignore the
        # extra headers — they're not harmful, just unused.
        return _mobile_cors(JSONResponse({
            "projects": list_projects(state.active_root),
            "default_permission_mode": cfg.default_permission_mode,
            "running": [
                {"tab_id": tab_id, "project": project, "age_s": int(time.time() - started)}
                for tab_id, project, started in running
            ],
            "workspace": {
                "default_root": str(state.default_root),
                "active_root": str(state.active_root),
                "allowed_roots": sorted(str(p) for p in state.allowed_roots),
            },
        }))

    @app.get("/api/git_diff")
    async def api_git_diff(
        project: str,
        _: None = Depends(require_auth),
    ):
        """Powers the phone's `/diff` slash command. Runs `git diff` in the
        project's working tree and returns the combined unstaged + staged
        diff text. Projects without a `.git/` directory return an empty
        diff (rather than an error) so the UX matches VSCode's /diff."""
        try:
            cwd = resolve_project(state.active_root, project)
        except ProjectNotFound as e:
            raise HTTPException(404, str(e))
        if not (cwd / ".git").exists():
            return {"diff": "", "note": "Not a git repository."}

        # Combine unstaged + staged so the user sees every pending change
        # in one pane — VSCode's /diff does the same.
        async def _run(args: list[str]) -> str:
            proc = await asyncio.create_subprocess_exec(
                "git", *args,
                cwd=str(cwd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=_NO_WINDOW,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=8.0)
            except asyncio.TimeoutError:
                proc.kill()
                raise HTTPException(504, "git diff timed out")
            if proc.returncode != 0:
                raise HTTPException(500, f"git diff failed: {stderr.decode('utf-8', 'replace')[:500]}")
            return stdout.decode("utf-8", "replace")

        unstaged = await _run(["diff", "--no-color"])
        staged = await _run(["diff", "--cached", "--no-color"])
        parts: list[str] = []
        if staged.strip():
            parts.append("# staged\n" + staged)
        if unstaged.strip():
            parts.append("# unstaged\n" + unstaged)
        diff = "\n".join(parts)
        # Cap response size so a giant tree-rewriting commit can't blow
        # past the WS frame limit on the way to the client.
        MAX_DIFF_CHARS = 200_000
        if len(diff) > MAX_DIFF_CHARS:
            diff = diff[:MAX_DIFF_CHARS] + f"\n\n# … (truncated, {len(diff) - MAX_DIFF_CHARS:,} more chars)"
        return {"diff": diff}

    # ─── Memory editor (/memory slash command) ────────────────────────
    # Three endpoints power the phone's /memory editor:
    #   GET  /api/memory/list?project=X   — enumerate memory files
    #   GET  /api/memory/file?project=X&path=Y — read one file
    #   POST /api/memory/file             — save one file
    # Security: every path is canonicalized and verified to live under the
    # project's working tree AND match one of the allow-listed shapes
    # (CLAUDE.md, .claude/CLAUDE.md, .claude/agents/*/memory/*.md). Writes
    # also enforce a size cap and refuse anything outside the .md extension.
    _MEMORY_MAX_BYTES = 256 * 1024  # 256 KB — anything bigger is not a memory file

    def _allowed_memory_path(cwd: Path, rel: str) -> Path:
        """Resolve `rel` against `cwd` and verify it's one of the allowed
        memory-file shapes. Raises HTTPException on any violation."""
        if not rel or ".." in rel.replace("\\", "/").split("/"):
            raise HTTPException(400, "bad path")
        # Normalize: accept forward OR backslash separators from the client
        # but operate on a single canonical form.
        rel_clean = rel.replace("\\", "/").lstrip("/")
        target = (cwd / rel_clean).resolve()
        cwd_resolved = cwd.resolve()
        try:
            target.relative_to(cwd_resolved)
        except ValueError:
            raise HTTPException(403, "path escapes project")
        if target.suffix.lower() != ".md":
            raise HTTPException(400, "only .md files allowed")
        # Shape check: relative path must look like CLAUDE.md,
        # .claude/CLAUDE.md, or .claude/agents/<anything>/memory/*.md
        rel_posix = target.relative_to(cwd_resolved).as_posix()
        ok = (
            rel_posix == "CLAUDE.md"
            or rel_posix == ".claude/CLAUDE.md"
            or (
                rel_posix.startswith(".claude/agents/")
                and "/memory/" in rel_posix
            )
        )
        if not ok:
            raise HTTPException(403, "path is not a memory file")
        return target

    @app.get("/api/memory/list")
    async def api_memory_list(
        project: str,
        _: None = Depends(require_auth),
    ):
        """Return every memory file the bridge will let the user edit for
        the given project. Empty list is fine — a project with no CLAUDE.md
        and no agents just has nothing to show."""
        try:
            cwd = resolve_project(state.active_root, project)
        except ProjectNotFound as e:
            raise HTTPException(404, str(e))
        out: list[dict[str, Any]] = []

        def _row(path: Path, label: str) -> dict[str, Any]:
            try:
                size = path.stat().st_size
            except OSError:
                size = 0
            return {
                "path": path.relative_to(cwd).as_posix(),
                "label": label,
                "size": size,
            }

        # Project-level CLAUDE.md (the one Claude loads on every run).
        root_claude = cwd / "CLAUDE.md"
        if root_claude.exists():
            out.append(_row(root_claude, "CLAUDE.md"))
        nested_claude = cwd / ".claude" / "CLAUDE.md"
        if nested_claude.exists():
            out.append(_row(nested_claude, ".claude/CLAUDE.md"))

        # Per-agent memory files. Each agent under .claude/agents/<name>/
        # gets its memory dir enumerated. The orchestrator's MEMORY.md
        # index + every dated session file are listed; same for any other
        # agent that has a memory/ folder.
        agents_root = cwd / ".claude" / "agents"
        if agents_root.is_dir():
            for agent_dir in sorted(agents_root.iterdir()):
                if not agent_dir.is_dir():
                    continue
                mem_dir = agent_dir / "memory"
                if not mem_dir.is_dir():
                    continue
                for f in sorted(mem_dir.iterdir()):
                    if f.is_file() and f.suffix.lower() == ".md":
                        out.append(_row(f, f"{agent_dir.name}/{f.name}"))

        return {"files": out, "cap_bytes": _MEMORY_MAX_BYTES}

    @app.get("/api/memory/file")
    async def api_memory_read(
        project: str,
        path: str,
        _: None = Depends(require_auth),
    ):
        try:
            cwd = resolve_project(state.active_root, project)
        except ProjectNotFound as e:
            raise HTTPException(404, str(e))
        target = _allowed_memory_path(cwd, path)
        if not target.exists():
            raise HTTPException(404, "no such memory file")
        try:
            content = target.read_text(encoding="utf-8")
        except OSError as e:
            raise HTTPException(500, f"read failed: {e}")
        return {"path": target.relative_to(cwd).as_posix(), "content": content}

    @app.post("/api/memory/file")
    async def api_memory_write(
        body: dict[str, Any],
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        project = body.get("project", "")
        rel = body.get("path", "")
        content = body.get("content", "")
        if not isinstance(content, str):
            raise HTTPException(400, "content must be a string")
        if len(content.encode("utf-8")) > _MEMORY_MAX_BYTES:
            raise HTTPException(413, f"file too large (cap {_MEMORY_MAX_BYTES} bytes)")
        try:
            cwd = resolve_project(state.active_root, project)
        except ProjectNotFound as e:
            raise HTTPException(404, str(e))
        target = _allowed_memory_path(cwd, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: write to a sibling .tmp then rename, so a crash
        # mid-save doesn't truncate the existing file.
        tmp = target.with_suffix(target.suffix + ".tmp")
        try:
            tmp.write_text(content, encoding="utf-8")
            tmp.replace(target)
        except OSError as e:
            raise HTTPException(500, f"write failed: {e}")
        return {"ok": True, "path": target.relative_to(cwd).as_posix(), "size": len(content)}

    # ─── /schedule slash command (Windows Task Scheduler bridge) ──────
    # Three endpoints power the phone's /schedule UI:
    #   GET  /api/schedule/list   — every `crc-*` task currently registered
    #   POST /api/schedule/create — create a new schtasks entry
    #   POST /api/schedule/delete — drop one
    #
    # The created task is a PowerShell one-liner that POSTs the configured
    # prompt to /api/trigger/<token> on this same laptop. The payload is
    # base64-encoded (UTF-16-LE) and passed via `-EncodedCommand` so we
    # don't have to fight schtasks's nested-quote rules. The token comes
    # from `cfg.trigger_token` (loaded from .crc-trigger-token on boot).
    #
    # Linux/macOS hosts get a clean 503 — the bridge is Windows-only today.
    _SCHED_NAME_PREFIX = "crc-"
    _SCHED_NAME_RE = re.compile(r"^[A-Za-z0-9_\- ]{1,80}$")

    async def _run_schtasks(args: list[str], timeout: float = 8.0) -> tuple[int, str, str]:
        """Run `schtasks` with the given args. Captures stdout/stderr as
        decoded strings; returns (rc, stdout, stderr). Hidden-window flag
        kept on so we never pop a console. Windows-only — raises 503 on
        anything else."""
        if sys.platform != "win32":
            raise HTTPException(503, "Scheduling is only supported on Windows hosts")
        proc = await asyncio.create_subprocess_exec(
            "schtasks", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=_NO_WINDOW,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise HTTPException(504, "schtasks timed out")
        return proc.returncode or 0, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace")

    _SCHED_SCRIPTS_DIR = Path(".cache") / "triggers"

    def _write_trigger_script(task_name: str, project: str, prompt: str, label: str) -> Path:
        """Materialize the PowerShell script the scheduled task will run.

        schtasks `/tr` is capped at 261 characters, so we cannot inline a
        base64-encoded payload. Instead each task gets its own `.ps1`
        sidecar under `.cache/triggers/<task-name>.ps1`; schtasks calls it
        via `powershell -File <path>`. The script reads `.crc-trigger-token`
        at fire time and POSTs the configured JSON to /api/trigger/<token>.
        """
        scripts_dir = (Path.cwd() / _SCHED_SCRIPTS_DIR).resolve()
        scripts_dir.mkdir(parents=True, exist_ok=True)
        token_path = (cfg.projects_root / ".crc-trigger-token").resolve()
        port = cfg.web_port
        body = json.dumps({
            "project": project,
            "prompt": prompt,
            "label": label or project,
        }, ensure_ascii=False)
        # Belt-and-suspenders: even though the body is placed inside a
        # PowerShell single-quoted here-string (which can only be
        # terminated by `'@` at column 0) AND json.dumps escapes every
        # real newline as `\n`, we also escape literal single-quotes by
        # doubling them — that way a future refactor that swaps the
        # here-string for a regular single-quoted PowerShell string
        # doesn't silently re-open the injection trap. Security-analyst
        # 2026-05-19 (Low). The here-string makes this a no-op in
        # practice because there are no real `'` characters to double.
        body_ps = body.replace("'", "''")
        # The .ps1 sidecar has a Byte-Order Mark so PowerShell reads it as
        # UTF-8 (the default cmdline-execution policy assumes BOM = UTF-8;
        # without a BOM, schtasks-spawned powershell.exe falls back to
        # system codepage and mangles non-ASCII content in the prompt).
        script = (
            "$ErrorActionPreference='Stop'\r\n"
            f"$tok=(Get-Content -Raw '{token_path}').Trim()\r\n"
            f"$body=@'\r\n{body_ps}\r\n'@\r\n"
            f"Invoke-RestMethod -Method Post "
            f"-Uri \"http://localhost:{port}/api/trigger/$tok\" "
            f"-ContentType 'application/json' "
            f"-Body $body | Out-Null\r\n"
        )
        path = scripts_dir / f"{task_name}.ps1"
        path.write_text("﻿" + script, encoding="utf-8")
        return path

    def _build_trigger_ps_command(script_path: Path) -> str:
        return f'powershell -NoProfile -WindowStyle Hidden -File "{script_path}"'

    @app.get("/api/schedule/list")
    async def api_schedule_list(_: None = Depends(require_auth)):
        if sys.platform != "win32":
            return {"tasks": [], "supported": False}
        # `/v` returns verbose columns (including Schedule + Next Run Time);
        # `/fo csv` is the easiest format to parse.
        rc, out, err = await _run_schtasks(["/query", "/fo", "csv", "/v"], timeout=15.0)
        if rc != 0:
            raise HTTPException(500, f"schtasks query failed: {err[:300]}")
        import csv as _csv
        from io import StringIO
        # `schtasks /v` emits one header row, then repeats the header
        # between every task block — we de-dup by tracking column positions
        # once. TaskName is column 0; values we care about: TaskName,
        # "Next Run Time", "Status", "Last Run Time", "Last Result".
        reader = _csv.reader(StringIO(out))
        rows = list(reader)
        if not rows:
            return {"tasks": [], "supported": True}
        header = rows[0]
        try:
            idx_name = header.index("TaskName")
            idx_next = header.index("Next Run Time")
            idx_status = header.index("Status")
            idx_last = header.index("Last Run Time")
        except ValueError:
            # Unexpected schema; bail with the names we do know.
            idx_name = 0; idx_next = 2; idx_status = 3; idx_last = 5
        tasks = []
        for r in rows[1:]:
            if not r or r == header:
                continue
            name_full = r[idx_name] if len(r) > idx_name else ""
            # schtasks prefixes task paths with a backslash; the bridge's
            # tasks live at root, so name looks like `\crc-<id>`.
            short = name_full.lstrip("\\")
            if not short.startswith(_SCHED_NAME_PREFIX):
                continue
            tasks.append({
                "name": short,
                "next_run": r[idx_next] if len(r) > idx_next else "",
                "status": r[idx_status] if len(r) > idx_status else "",
                "last_run": r[idx_last] if len(r) > idx_last else "",
            })
        # Stable sort by name for a predictable list order.
        tasks.sort(key=lambda t: t["name"])
        return {"tasks": tasks, "supported": True}

    @app.post("/api/schedule/create")
    async def api_schedule_create(
        body: dict[str, Any],
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        if sys.platform != "win32":
            raise HTTPException(503, "Scheduling is only supported on Windows hosts")
        suffix = (body.get("name") or "").strip()
        project = (body.get("project") or "").strip()
        prompt = (body.get("prompt") or "").strip()
        label = (body.get("label") or "")[:60]
        kind = (body.get("kind") or "interval").strip()
        # Validate the user-supplied suffix.
        if not suffix or not _SCHED_NAME_RE.match(suffix):
            raise HTTPException(400, "name must match [A-Za-z0-9_- ] (1–80 chars)")
        if not project or not prompt:
            raise HTTPException(400, "project and prompt are required")
        # Project resolves so we fail early on bad names — but don't store
        # the resolved path; the task only knows the project NAME.
        try:
            resolve_project(state.active_root, project)
        except ProjectNotFound as e:
            raise HTTPException(404, str(e))

        task_name = f"{_SCHED_NAME_PREFIX}{suffix}"
        script_path = _write_trigger_script(task_name, project, prompt, label or project)
        tr_cmd = _build_trigger_ps_command(script_path)

        args = ["/create", "/tn", task_name, "/tr", tr_cmd, "/f"]
        if kind == "interval":
            minutes = int(body.get("minutes") or 0)
            if minutes < 1 or minutes > 1439:
                raise HTTPException(400, "interval minutes must be 1..1439")
            args += ["/sc", "minute", "/mo", str(minutes)]
        elif kind == "once":
            # Expect ISO-like "YYYY-MM-DDTHH:MM" from <input type=datetime-local>.
            iso = (body.get("when") or "").strip()
            if "T" not in iso:
                raise HTTPException(400, "when must be ISO datetime YYYY-MM-DDTHH:MM")
            try:
                date_part, time_part = iso.split("T", 1)
                yyyy, mm, dd = date_part.split("-")
                hh, mi = time_part.split(":")[:2]
            except Exception:
                raise HTTPException(400, "bad ISO datetime")
            args += [
                "/sc", "once",
                "/sd", f"{mm}/{dd}/{yyyy}",
                "/st", f"{hh}:{mi}",
            ]
        elif kind == "daily":
            t = (body.get("time") or "").strip()
            # Match HH:MM with optional leading zero — anything else (extra
            # tokens after the time, garbage suffixes) reaches schtasks as
            # a single arg and surfaces as a 500. Reject early. Security-
            # analyst 2026-05-19 (Low).
            if not re.fullmatch(r"\d{1,2}:\d{2}", t):
                raise HTTPException(400, "time must be HH:MM")
            args += ["/sc", "daily", "/st", t]
        else:
            raise HTTPException(400, f"unknown kind: {kind}")

        rc, out, err = await _run_schtasks(args, timeout=10.0)
        if rc != 0:
            raise HTTPException(500, f"schtasks create failed: {(err or out)[:300]}")
        return {"ok": True, "name": task_name}

    @app.post("/api/schedule/delete")
    async def api_schedule_delete(
        body: dict[str, Any],
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        if sys.platform != "win32":
            raise HTTPException(503, "Scheduling is only supported on Windows hosts")
        name = (body.get("name") or "").strip()
        # Refuse to delete anything not under our `crc-` prefix — protects
        # the rest of the user's Task Scheduler if a bug feeds the wrong
        # name through.
        if not name.startswith(_SCHED_NAME_PREFIX):
            raise HTTPException(400, "name must start with `crc-`")
        # Re-validate the suffix against `_SCHED_NAME_RE` (same allow-list
        # we use on create). The original create-time regex rejected path
        # separators; without re-applying it on delete, a caller could
        # POST `crc-foo\..\..\Windows\evil` and have the bare `Path()`
        # construction below interpret the backslashes as directory
        # separators — letting the sidecar `unlink()` reach outside
        # `.cache/triggers/`. Schtasks itself also interprets backslashes
        # in task names as folder separators, which would let the call
        # navigate to and delete an unrelated task. Security-analyst
        # 2026-05-19 (Medium).
        suffix = name[len(_SCHED_NAME_PREFIX):]
        if not _SCHED_NAME_RE.match(suffix):
            raise HTTPException(400, "invalid task name")
        rc, out, err = await _run_schtasks(["/delete", "/tn", name, "/f"], timeout=8.0)
        if rc != 0:
            raise HTTPException(500, f"schtasks delete failed: {(err or out)[:300]}")
        # Best-effort sidecar cleanup with belt-and-suspenders path-jail:
        # even though the suffix is re-validated above, we resolve the
        # target and confirm it sits under the triggers dir before
        # unlinking. Failures are silent so an already-missing file
        # doesn't surface as a half-success.
        try:
            scripts_dir = (Path.cwd() / _SCHED_SCRIPTS_DIR).resolve()
            sidecar = (scripts_dir / f"{name}.ps1").resolve()
            sidecar.relative_to(scripts_dir)
            sidecar.unlink()
        except (OSError, ValueError):
            pass
        return {"ok": True}

    # Parses YAML-frontmatter agent files (.claude/agents/<name>.md). The
    # frontmatter is minimal enough that we don't need a YAML library —
    # `name:`, `description:`, `tools:` (optional) are the only fields
    # claude.exe respects. Anything fancier in the frontmatter is ignored.
    _AGENT_FIELD_RE = re.compile(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$")

    def _parse_agent_md(path: Path) -> dict[str, str] | None:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        if not text.startswith("---"):
            return None
        # Frontmatter is delimited by leading and trailing `---` on their
        # own lines. We don't validate ordering — just consume lines until
        # the second `---`.
        lines = text.splitlines()
        i = 1
        fm: dict[str, str] = {}
        while i < len(lines) and lines[i].strip() != "---":
            m = _AGENT_FIELD_RE.match(lines[i])
            if m:
                fm[m.group(1).lower()] = m.group(2).strip()
            i += 1
        # Filename without `.md` is the canonical agent name when the
        # frontmatter doesn't declare one explicitly.
        fm.setdefault("name", path.stem)
        return fm

    @app.get("/api/agents")
    async def api_agents(
        project: str,
        _: None = Depends(require_auth),
    ):
        """Powers the phone's `/agents` slash command. Reads agent
        definitions from `<project>/.claude/agents/*.md` and returns
        their parsed frontmatter. Matches VSCode's /agents picker."""
        try:
            cwd = resolve_project(state.active_root, project)
        except ProjectNotFound as e:
            raise HTTPException(404, str(e))
        agents_dir = cwd / ".claude" / "agents"
        if not agents_dir.is_dir():
            return {"agents": []}
        out: list[dict[str, str]] = []
        try:
            for f in sorted(agents_dir.glob("*.md")):
                if not f.is_file():
                    continue
                fm = _parse_agent_md(f)
                if not fm:
                    continue
                out.append({
                    "name": fm.get("name", f.stem),
                    "description": fm.get("description", ""),
                    "tools": fm.get("tools", ""),
                })
        except OSError as e:
            raise HTTPException(500, f"Couldn't read agents directory: {e}")
        return {"agents": out}

    def _agent_path(project: str, name: str) -> Path:
        """Resolve the on-disk file for a subagent, with path-jail enforced.
        Both `project` and `name` flow through user-controlled fields so
        every part must be validated before opening anything."""
        if not _AGENT_NAME_RE.match(name):
            raise HTTPException(400, "Invalid agent name (letters/digits/dash/underscore, up to 64 chars).")
        try:
            cwd = resolve_project(state.active_root, project)
        except ProjectNotFound as e:
            raise HTTPException(404, str(e))
        agents_dir = (cwd / ".claude" / "agents").resolve()
        target = (agents_dir / f"{name}.md").resolve()
        try:
            target.relative_to(agents_dir)
        except ValueError:
            raise HTTPException(400, "Resolved path escapes the project's .claude/agents/ folder.")
        return target

    def _serialize_agent_md(
        *, name: str, description: str, tools: str, model: str, body: str,
    ) -> str:
        """Render the markdown file format the Claude CLI reads. The
        frontmatter is YAML-ish but the CLI only parses the `key: value`
        lines we emit — no nested structures."""
        lines = ["---", f"name: {name}"]
        if description:
            lines.append(f"description: {description}")
        if tools:
            lines.append(f"tools: {tools}")
        if model:
            lines.append(f"model: {model}")
        lines.append("---")
        lines.append("")
        lines.append(body.rstrip() + "\n")
        return "\n".join(lines)

    def _atomic_write(path: Path, text: str) -> None:
        """Write `text` to `path` via temp+rename so a partial write can't
        clobber the original — and keep a `.bak` of any prior content so
        the user can recover if the new content breaks claude on next run."""
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            try:
                bak = path.with_suffix(path.suffix + ".bak")
                bak.write_bytes(path.read_bytes())
            except OSError:
                log.warning("agent backup failed for %s", path)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(path)

    @app.get("/api/agents/{name}")
    async def api_agent_get(
        name: str,
        project: str,
        _: None = Depends(require_auth),
    ):
        target = _agent_path(project, name)
        if not target.is_file():
            raise HTTPException(404, f"Agent '{name}' not found.")
        try:
            raw = target.read_text(encoding="utf-8")
        except OSError as e:
            raise HTTPException(500, f"Couldn't read agent file: {e}")
        # Strip frontmatter into a dict; the rest is the body.
        lines = raw.splitlines()
        body_lines: list[str] = []
        fm: dict[str, str] = {}
        if lines and lines[0].strip() == "---":
            i = 1
            while i < len(lines) and lines[i].strip() != "---":
                m = _AGENT_FIELD_RE.match(lines[i])
                if m:
                    fm[m.group(1).lower()] = m.group(2).strip()
                i += 1
            body_lines = lines[i + 1:] if i + 1 <= len(lines) else []
        else:
            body_lines = lines
        return {
            "name": fm.get("name", name),
            "description": fm.get("description", ""),
            "tools": fm.get("tools", ""),
            "model": fm.get("model", ""),
            "body": "\n".join(body_lines).strip("\n"),
        }

    @app.post("/api/agents")
    async def api_agent_create(
        body_in: dict[str, Any] = Body(...),
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        project = (body_in.get("project") or "").strip()
        name = (body_in.get("name") or "").strip()
        target = _agent_path(project, name)
        if target.exists():
            raise HTTPException(409, f"Agent '{name}' already exists. Use PUT to update.")
        content = _serialize_agent_md(
            name=name,
            description=(body_in.get("description") or "").strip(),
            tools=(body_in.get("tools") or "").strip(),
            model=(body_in.get("model") or "").strip(),
            body=body_in.get("body") or "",
        )
        try:
            _atomic_write(target, content)
        except OSError as e:
            raise HTTPException(500, f"Couldn't write agent file: {e}")
        return {"ok": True, "name": name}

    @app.put("/api/agents/{name}")
    async def api_agent_update(
        name: str,
        body_in: dict[str, Any] = Body(...),
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        project = (body_in.get("project") or "").strip()
        target = _agent_path(project, name)
        if not target.is_file():
            raise HTTPException(404, f"Agent '{name}' not found.")
        content = _serialize_agent_md(
            name=(body_in.get("name") or name).strip() or name,
            description=(body_in.get("description") or "").strip(),
            tools=(body_in.get("tools") or "").strip(),
            model=(body_in.get("model") or "").strip(),
            body=body_in.get("body") or "",
        )
        try:
            _atomic_write(target, content)
        except OSError as e:
            raise HTTPException(500, f"Couldn't write agent file: {e}")
        return {"ok": True, "name": name}

    @app.delete("/api/agents/{name}")
    async def api_agent_delete(
        name: str,
        project: str,
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        target = _agent_path(project, name)
        if not target.is_file():
            raise HTTPException(404, f"Agent '{name}' not found.")
        try:
            bak = target.with_suffix(target.suffix + ".bak")
            try:
                bak.write_bytes(target.read_bytes())
            except OSError:
                log.warning("agent backup failed before delete: %s", target)
            target.unlink()
        except OSError as e:
            raise HTTPException(500, f"Couldn't delete agent file: {e}")
        return {"ok": True, "name": name}

    # ── MCP server management ────────────────────────────────────────────
    #
    # Wraps `claude mcp list / add / remove` so the phone can manage MCP
    # servers without an interactive REPL. OAuth-based MCP servers (e.g.
    # claude.ai Gmail/Drive/Calendar) still require browser interaction —
    # the user must run `/mcp` from their laptop's claude REPL to complete
    # those flows. This endpoint only covers add/remove of non-OAuth
    # servers and the read-only list view.
    _MCP_NAME_RE = re.compile(r"^[A-Za-z0-9 ._-]{1,64}$")
    _MCP_TRANSPORTS = frozenset({"http", "sse", "stdio"})
    _MCP_SCOPES = frozenset({"local", "user", "project"})
    # The list output format claude uses is one server per line:
    #   "<name>: <url-or-command> - <status>"
    # status is a short phrase like "✓ Connected" / "! Needs authentication"
    # / "✗ Failed". We tolerate any non-empty status string.
    _MCP_LIST_RE = re.compile(r"^(?P<name>[^:]+?):\s+(?P<target>.+?)(?:\s+-\s+(?P<status>.+))?$")

    async def _run_claude_mcp(args: list[str], cwd: Path | None = None) -> tuple[int, str, str]:
        """Run `claude mcp <args>` headlessly. Returns (code, stdout, stderr)."""
        proc = await asyncio.create_subprocess_exec(
            cfg.claude_cmd, "mcp", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=_NO_WINDOW,
            cwd=str(cwd) if cwd else None,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=15.0)
        except asyncio.TimeoutError:
            proc.kill()
            return (-1, "", "claude mcp timed out")
        return (
            proc.returncode if proc.returncode is not None else -1,
            out.decode("utf-8", errors="replace"),
            err.decode("utf-8", errors="replace"),
        )

    @app.get("/api/mcp/servers")
    async def api_mcp_list(
        project: str = "",
        _: None = Depends(require_auth),
    ):
        """List MCP servers visible from the active project's cwd. Falls back
        to the projects_root when no project is specified."""
        cwd: Path | None = None
        if project:
            try:
                cwd = resolve_project(state.active_root, project)
            except ProjectNotFound as e:
                raise HTTPException(404, str(e))
        code, out, err = await _run_claude_mcp(["list"], cwd=cwd)
        servers: list[dict[str, str]] = []
        for raw in out.splitlines():
            line = raw.strip()
            if not line or line.startswith("Checking ") or line.endswith(":"):
                continue
            m = _MCP_LIST_RE.match(line)
            if not m:
                continue
            servers.append({
                "name": m.group("name").strip(),
                "target": m.group("target").strip(),
                "status": (m.group("status") or "").strip(),
            })
        return {"servers": servers, "exit_code": code, "stderr": err.strip()}

    @app.post("/api/mcp/servers")
    async def api_mcp_add(
        body: dict[str, Any] = Body(...),
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        """Add an MCP server via `claude mcp add`. Project-scope by default
        so the resulting `.mcp.json` is the canonical record."""
        name = (body.get("name") or "").strip()
        transport = (body.get("transport") or "http").strip().lower()
        target = (body.get("target") or "").strip()
        scope = (body.get("scope") or "project").strip().lower()
        project = (body.get("project") or "").strip()
        if not _MCP_NAME_RE.match(name):
            raise HTTPException(400, "Invalid server name (letters, digits, dot, space, underscore, dash; up to 64 chars).")
        if transport not in _MCP_TRANSPORTS:
            raise HTTPException(400, f"Invalid transport: {transport}")
        if scope not in _MCP_SCOPES:
            raise HTTPException(400, f"Invalid scope: {scope}")
        if not target:
            raise HTTPException(400, "Server target (URL or command) is required.")
        if transport in {"http", "sse"} and not target.lower().startswith(("http://", "https://")):
            raise HTTPException(400, "HTTP/SSE transport requires an http(s):// URL.")
        cwd: Path | None = None
        if project:
            try:
                cwd = resolve_project(state.active_root, project)
            except ProjectNotFound as e:
                raise HTTPException(404, str(e))
        args = ["add", "--scope", scope, "--transport", transport, name, target]
        code, out, err = await _run_claude_mcp(args, cwd=cwd)
        if code != 0:
            raise HTTPException(400, (err or out or f"claude mcp add exited with code {code}").strip())
        return {"ok": True, "stdout": out.strip()}

    @app.delete("/api/mcp/servers/{name}")
    async def api_mcp_remove(
        name: str,
        project: str = "",
        scope: str = "project",
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        """Remove an MCP server via `claude mcp remove`."""
        if not _MCP_NAME_RE.match(name):
            raise HTTPException(400, "Invalid server name.")
        if scope not in _MCP_SCOPES:
            raise HTTPException(400, f"Invalid scope: {scope}")
        cwd: Path | None = None
        if project:
            try:
                cwd = resolve_project(state.active_root, project)
            except ProjectNotFound as e:
                raise HTTPException(404, str(e))
        code, out, err = await _run_claude_mcp(["remove", "--scope", scope, name], cwd=cwd)
        if code != 0:
            raise HTTPException(400, (err or out or f"claude mcp remove exited with code {code}").strip())
        return {"ok": True, "stdout": out.strip()}

    # ── Workspace switching ──────────────────────────────────────────────
    #
    # PROJECTS_ROOT in .env.local is the bootstrap default the user picks
    # at install time. The phone can switch the ACTIVE root to any other
    # existing directory at runtime — useful when the user keeps several
    # project trees on disk and wants to flip between them without
    # editing .env.local + restarting the bridge.
    #
    # Reverts to the default on every bridge restart so the install stays
    # reproducible from the .env.local config. Path-jail is preserved:
    # `resolve_project()` and `list_projects()` accept the active root
    # directly and enforce the same no-`..`, no-escape rules.

    # Folder name validator for mkdir — letters/digits/dash/underscore/
    # space/dot only. Rejects slashes (so the user can't traverse), '..'
    # (so they can't escape via name), and reserved Windows names.
    _FOLDER_NAME_RE = re.compile(r"^[A-Za-z0-9 _.\-]{1,80}$")

    def _validate_root(raw: str) -> Path:
        path_str = (raw or "").strip()
        if not path_str:
            raise HTTPException(400, "Workspace root path is empty.")
        candidate = Path(path_str).expanduser()
        if not candidate.is_absolute():
            raise HTTPException(400, "Workspace root must be an absolute path.")
        try:
            resolved = candidate.resolve()
        except (OSError, RuntimeError) as e:
            raise HTTPException(400, f"Couldn't resolve path: {e}")
        if not resolved.is_dir():
            raise HTTPException(400, f"Path is not a directory: {resolved}")
        # WORKSPACE_ROOT_LOCK confines the picker to projects_root. Limits
        # blast radius if the password ever leaks: the client can't pivot
        # to "/" or %USERPROFILE% to enumerate the disk.
        if cfg.workspace_root_lock:
            try:
                resolved.relative_to(cfg.projects_root.resolve())
            except ValueError:
                raise HTTPException(
                    403,
                    "Workspace lock is enabled — paths outside PROJECTS_ROOT "
                    f"({cfg.projects_root}) are not browsable.",
                )
        return resolved

    @app.get("/api/workspace/shortcuts")
    async def workspace_shortcuts(_: None = Depends(require_auth)):
        """Common folders the user is likely to want to jump to from
        the picker. Resolved server-side so we get the OS-native paths
        (Windows `C:\\Users\\X\\Downloads`, etc.) without the client
        guessing. Folders that don't exist on this OS are skipped."""
        home = Path.home()
        # icon is now a slug pointing at `static/icons/ui/<slug>.png` — the
        # client renders an <img>, not an emoji. See tools/generate_ui_icons.py
        # for the source set.
        candidates = [
            ("Home", home, "home"),
            ("Desktop", home / "Desktop", "desktop"),
            ("Documents", home / "Documents", "documents"),
            ("Downloads", home / "Downloads", "downloads"),
            ("Projects (default)", state.default_root, "star"),
        ]
        # When the workspace is locked to PROJECTS_ROOT, drop shortcuts that
        # point outside it — otherwise the lock is bypassable in one tap.
        projects_root_resolved = cfg.projects_root.resolve()
        out: list[dict[str, str]] = []
        seen: set[str] = set()
        for label, path, icon in candidates:
            try:
                resolved = path.resolve()
            except OSError:
                continue
            if not resolved.is_dir():
                continue
            if cfg.workspace_root_lock:
                try:
                    resolved.relative_to(projects_root_resolved)
                except ValueError:
                    continue
            key = str(resolved)
            if key in seen:
                continue
            seen.add(key)
            out.append({"label": label, "path": key, "icon": icon})
        return {"shortcuts": out}

    @app.get("/api/workspace/browse")
    async def workspace_browse(
        path: str | None = None,
        _: None = Depends(require_auth),
    ):
        """List immediate subdirectories of `path` so the phone's folder
        picker can render them. Defaults to the active root when no path
        is given. The user is already authenticated and the bridge runs
        on their own laptop, so this isn't a privilege escalation
        surface — but path-resolves are still made absolute + filtered
        to existing dirs so a malformed query can't crash the handler."""
        base = _validate_root(path) if path else state.active_root
        out_dirs: list[dict[str, str]] = []
        try:
            for child in sorted(base.iterdir(), key=lambda p: p.name.lower()):
                if not child.is_dir():
                    continue
                # Skip dotfile dirs in the workspace picker. They're
                # bridge-internal (.crc-tmp, .web-uploads, .claude) or
                # the user's hidden config — neither is "a project."
                if child.name.startswith("."):
                    continue
                out_dirs.append({"name": child.name, "path": str(child)})
        except (OSError, PermissionError) as e:
            raise HTTPException(403, f"Couldn't list directory: {e}")
        parent = base.parent if base.parent != base else None
        return {
            "path": str(base),
            "parent": str(parent) if parent else None,
            "dirs": out_dirs,
        }

    @app.post("/api/workspace/set_root")
    async def workspace_set_root(
        body: dict[str, Any] = Body(...),
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        """Switch the active workspace root. Subsequent project picks
        resolve against this path. Existing tabs that already captured a
        cwd from a prior run are unaffected — their resume continues."""
        path = _validate_root(body.get("path") or "")
        new_root = state.set_active_root(path)
        return {
            "ok": True,
            "active_root": str(new_root),
            "default_root": str(state.default_root),
            "projects": list_projects(new_root),
        }

    @app.post("/api/workspace/reset_root")
    async def workspace_reset_root(
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        """Revert the active workspace to the default (from .env.local).
        Equivalent to `set_root` with the default path, but exposed as a
        dedicated endpoint so the phone UI can present a clear 'reset'
        affordance without echoing the path back to the server."""
        new_root = state.set_active_root(state.default_root)
        return {
            "ok": True,
            "active_root": str(new_root),
            "default_root": str(state.default_root),
            "projects": list_projects(new_root),
        }

    @app.post("/api/workspace/mkdir")
    async def workspace_mkdir(
        body: dict[str, Any] = Body(...),
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        """Create a new folder inside `parent` (or active_root by default).
        When the user is browsing a non-root directory in the folder picker
        and taps "Create new folder", the client passes `parent=<that dir>`
        so the folder lands where the user is looking. Returns the new
        folder's name so the picker can immediately refresh and select it."""
        name = (body.get("name") or "").strip()
        parent_raw = (body.get("parent") or "").strip()
        if not _FOLDER_NAME_RE.match(name):
            raise HTTPException(
                400,
                "Folder name must be 1–80 chars, letters/digits/space/dash/"
                "underscore/dot only. No slashes, no '..'.",
            )
        # Pick parent: client-provided path (must be a real directory),
        # otherwise the active workspace root.
        if parent_raw:
            try:
                parent = _validate_root(parent_raw)
            except HTTPException:
                raise
        else:
            parent = state.active_root
        target = (parent / name).resolve()
        try:
            target.relative_to(parent.resolve())
        except ValueError:
            raise HTTPException(400, "Folder name escapes the parent directory.")
        if target.exists():
            raise HTTPException(409, f"Folder already exists: {name}")
        try:
            target.mkdir(parents=False, exist_ok=False)
        except OSError as e:
            raise HTTPException(500, f"Couldn't create folder: {e}")
        return {
            "ok": True,
            "name": name,
            "path": str(target),
            "parent": str(parent),
            "projects": list_projects(state.active_root),
        }

    @app.post("/api/context")
    async def api_context(
        request: Request,
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        """Resolve a project-relative path into an absolute path inside the
        project, after validating it doesn't escape PROJECTS_ROOT. Returns
        size + mime so the client can render a useful chip. The file is NOT
        copied anywhere — it stays where it lives; we just hand back the
        absolute path which the prompt will hand to claude's Read tool."""
        body = await request.json()
        project = (body.get("project") or "").strip()
        sub_path = (body.get("path") or "").strip()
        if not project or not sub_path:
            raise HTTPException(400, "project and path required")
        try:
            cwd = resolve_project(state.active_root,project)
        except ProjectNotFound as e:
            raise HTTPException(404, str(e))
        # Same path-jail as resolve_project, applied to the SUB-path within cwd.
        if Path(sub_path).is_absolute() or Path(sub_path).drive:
            raise HTTPException(400, "Use a path relative to the project root.")
        candidate = (cwd / sub_path).resolve()
        try:
            candidate.relative_to(cwd)
        except ValueError:
            raise HTTPException(400, f"Path escapes the project: {sub_path}")
        if not candidate.exists():
            raise HTTPException(404, f"Not found in project: {sub_path}")
        if not candidate.is_file():
            raise HTTPException(400, "Path must point to a file, not a directory.")
        return {
            "path": str(candidate),
            "size": candidate.stat().st_size,
            "mime": "application/octet-stream",
        }

    @app.post("/api/upload")
    async def api_upload(
        project: str = Form(...),
        files: list[UploadFile] = File(...),
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        """Receive one or more files from the PWA. Saves them to
        <PROJECTS_ROOT>/.web-uploads/<project>/ (centralized so the user
        can manage all uploads from one place via Menu → Manage uploads).
        Returns the absolute paths so the next /prompt can reference them.

        Filenames are sanitized for Windows: NTFS alt-stream syntax stripped,
        reserved device names (CON, NUL, …) rejected, path components removed.
        Total per-request bytes are bounded by WEB_MAX_UPLOAD_MB.
        """
        try:
            resolve_project(state.active_root, project)
        except ProjectNotFound as e:
            raise HTTPException(status_code=404, detail=str(e))
        upload_dir = _uploads_dir_for(cfg.projects_root, project)
        upload_dir.mkdir(parents=True, exist_ok=True)
        out_paths: list[dict[str, Any]] = []
        budget = max_upload_bytes  # shared across files in one request
        for f in files:
            name = _safe_upload_name(f.filename or "file.bin")
            if name is None:
                raise HTTPException(status_code=400, detail="Invalid filename")
            # Add a short uuid so concurrent uploads with the same filename
            # don't clobber each other.
            unique = f"{uuid.uuid4().hex[:8]}_{name}"
            dest = upload_dir / unique
            data = await _read_capped(f, limit=budget)
            budget -= len(data)
            # Downscale oversized images BEFORE write so disk and the
            # subsequent API call both see the trimmed bytes. No-op for
            # non-image payloads or already-small images. See
            # _maybe_shrink_image() for the why. Off-loaded to a thread
            # because Pillow decode + LANCZOS + re-encode is CPU-bound
            # — a 12 MP iPhone shot can spend 300+ ms in that path, and
            # blocking the event loop would stall every other request
            # and every WS frame for the duration.
            data = await asyncio.to_thread(_maybe_shrink_image, data, f.content_type)
            dest.write_bytes(data)
            out_paths.append({
                "name": name,
                "path": str(dest),
                "size": dest.stat().st_size,
                "mime": f.content_type or "application/octet-stream",
            })
        return {"files": out_paths}

    # Hard cap on a single transcription request: 60s of speech at AAC/Opus
    # bitrates is well under a megabyte, so 25 MB is generous headroom while
    # still keeping a buggy/malicious client from streaming gigabytes of audio
    # at us.
    _TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024

    @app.post("/api/transcribe")
    async def api_transcribe(
        request: Request,
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        """Transcribe a single audio clip via local Whisper.

        The phone's MediaRecorder POSTs raw audio bytes (webm/opus on
        Chrome/Android, mp4/aac on iOS Safari) as the request body —
        NOT multipart. Multipart goes through Starlette's UploadFile
        which spools >1MB payloads to a tempfile in the OS temp dir;
        even though Starlette cleans it up on request teardown, "audio
        never touches disk" is only literally true when we read straight
        off `request.stream()` into a bytes buffer. So we do that.

        Query param `partial=1` toggles the fast-path used by the live
        streaming poller while the user is still speaking (skips VAD).
        """
        from .transcribe import TranscribeError, transcribe_bytes
        # Bound the read so a buggy/malicious client can't stream us
        # gigabytes. Accumulate chunks in a list and join once at the
        # end — single allocation, no intermediate temp file.
        buf: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            if not chunk:
                continue
            total += len(chunk)
            if total > _TRANSCRIBE_MAX_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"Audio exceeds {_TRANSCRIBE_MAX_BYTES // (1024 * 1024)} MB cap",
                )
            buf.append(chunk)
        data = b"".join(buf)
        if not data:
            raise HTTPException(status_code=400, detail="Empty audio payload")
        partial = request.query_params.get("partial") in {"1", "true", "yes"}
        try:
            text = await transcribe_bytes(data, partial=partial)
        except TranscribeError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"text": text}

    @app.get("/api/uploads/list")
    async def api_uploads_list(_: None = Depends(require_auth)):
        """List every project subfolder under `<PROJECTS_ROOT>/.web-uploads/`
        with its size + file count. Powers the Menu → Manage uploads UI.
        Total at the top is the sum of subfolders."""
        base = _uploads_base_dir(cfg.projects_root)
        rows: list[dict[str, Any]] = []
        total_bytes = 0
        total_files = 0
        if base.is_dir():
            for sub in sorted(base.iterdir()):
                if not sub.is_dir():
                    continue
                sub_bytes = 0
                sub_files = 0
                try:
                    for f in sub.iterdir():
                        if f.is_file():
                            try:
                                sub_bytes += f.stat().st_size
                            except OSError:
                                continue
                            sub_files += 1
                except OSError:
                    continue
                rows.append({
                    "project": sub.name,
                    "files": sub_files,
                    "bytes": sub_bytes,
                })
                total_bytes += sub_bytes
                total_files += sub_files
        return {
            "base": str(base),
            "projects": rows,
            "total_files": total_files,
            "total_bytes": total_bytes,
        }

    @app.post("/api/uploads/clear")
    async def api_uploads_clear(
        body: dict[str, Any] = Body(...),
        _: None = Depends(require_auth),
        __: None = Depends(require_csrf),
    ):
        """Delete uploads. Body shapes:
          - `{"all": true, "confirm": "DELETE_ALL"}` — wipe every project
            subfolder. The `confirm` token is mandatory: it ensures a
            stray scripted POST (or autofill mishap) can't nuke the
            whole upload tree without explicit intent.
          - `{"projects": ["a","b"]}` — wipe only those subfolders.
        Skips anything outside the central `.web-uploads/` base for
        defense-in-depth. Returns counts of files deleted."""
        base = _uploads_base_dir(cfg.projects_root).resolve()
        if not base.is_dir():
            return {"deleted_files": 0, "deleted_bytes": 0, "projects_cleared": []}
        wipe_all = bool(body.get("all"))
        names = body.get("projects") or []
        if not wipe_all and (not isinstance(names, list) or not names):
            raise HTTPException(400, "Specify {all:true,confirm:'DELETE_ALL'} or {projects:[...]}")
        if wipe_all and body.get("confirm") != "DELETE_ALL":
            raise HTTPException(400, "Wipe-all requires confirm='DELETE_ALL' token")
        if wipe_all:
            targets = [p for p in base.iterdir() if p.is_dir()]
        else:
            targets = []
            for n in names:
                if not isinstance(n, str) or "/" in n or "\\" in n or n.startswith("."):
                    raise HTTPException(400, f"Invalid project name: {n!r}")
                p = (base / n).resolve()
                try:
                    p.relative_to(base)
                except ValueError:
                    raise HTTPException(400, f"Path escapes uploads base: {n!r}")
                if p.is_dir():
                    targets.append(p)
        deleted_files = 0
        deleted_bytes = 0
        cleared: list[str] = []
        for sub in targets:
            try:
                files = [f for f in sub.iterdir() if f.is_file()]
            except OSError:
                continue
            for f in files:
                try:
                    size = f.stat().st_size
                    f.unlink()
                    deleted_files += 1
                    deleted_bytes += size
                except OSError:
                    continue
            try:
                sub.rmdir()
            except OSError:
                pass
            cleared.append(sub.name)
        return {
            "deleted_files": deleted_files,
            "deleted_bytes": deleted_bytes,
            "projects_cleared": cleared,
        }

    # ── Media downloads (watcher output) ─────────────────────────────────

    # Hand-rolled extension→mime map for the /media endpoint. FastAPI's
    # FileResponse normally derives Content-Type via mimetypes.guess_type,
    # which on Windows reads the registry and can return None for common
    # animated/static image formats depending on which apps the user has
    # installed. Combined with the global `X-Content-Type-Options: nosniff`
    # header (set in the static-cache middleware), an
    # `application/octet-stream` fallback causes the browser to refuse
    # rendering — the chip thumbnail then shows the broken-image "?"
    # placeholder while the lightbox (which also uses /media) hits the
    # same response and ought to fail identically; in practice some
    # iOS WebKit builds will still attempt to decode large image
    # downloads, which explains the user-reported "chat thumb is a ?,
    # lightbox is fine" asymmetry on GIFs. Belt-and-suspenders: pin a
    # known good Content-Type for every extension the watcher / upload
    # path can produce. Keep in sync with watcher.ALLOWED_EXTS.
    _MEDIA_MIMES: dict[str, str] = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".jfif": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".avif": "image/avif",
        ".heic": "image/heic",
        ".svg": "image/svg+xml",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
    }

    @app.get("/media/{token}")
    async def media(token: str, crc_auth: str | None = Cookie(default=None, alias=AUTH_COOKIE)):
        # Cookie auth — <img src=…> tags would otherwise bypass require_auth's
        # dependency, but the browser does forward our cookie automatically.
        if not _is_authed(crc_auth):
            raise HTTPException(status_code=401)
        entry = media_tokens.get(token)
        if entry is None:
            raise HTTPException(status_code=404)
        path, expires = entry
        if time.time() > expires:
            media_tokens.pop(token, None)
            raise HTTPException(status_code=410)  # Gone
        if not path.exists():
            raise HTTPException(status_code=404)
        media_type = _MEDIA_MIMES.get(path.suffix.lower())
        if media_type:
            return FileResponse(path, media_type=media_type)
        return FileResponse(path)

    # ── Static ───────────────────────────────────────────────────────────

    # Force no-store on static assets too. iOS Safari was holding onto old
    # CSS/JS even with query-string version bumps in the HTML — the user spent
    # an hour debugging stale UI. Single-user app, kilobytes per page load,
    # the perf cost is irrelevant.
    @app.middleware("http")
    async def _no_cache_static(request: Request, call_next):
        resp = await call_next(request)
        if request.url.path.startswith("/static/") or request.url.path in {"/sw.js", "/manifest.webmanifest"}:
            resp.headers["Cache-Control"] = "no-store, must-revalidate"
            resp.headers["Pragma"] = "no-cache"
        # CORS only on .js files — needed so the page can load app.js
        # with `crossorigin="anonymous"` and surface real stack traces
        # instead of the sanitised "Script error." iOS Safari otherwise
        # returns for module-scope exceptions. Limited to .js so that
        # any future non-public asset (auth config, signed manifest,
        # etc.) parked under /static/ cannot accidentally leak
        # cross-origin via a wildcard ACAO. Service-worker scope (/sw.js)
        # is at the root path — that one's served by its own handler
        # below, which doesn't need cross-origin attribution.
        if request.url.path.startswith("/static/") and request.url.path.endswith(".js"):
            resp.headers["Access-Control-Allow-Origin"] = "*"
        # Clickjacking defence: no third-party page should be able to
        # embed the chat UI in an iframe. CSRF header gate already
        # blocks state-changing POSTs over a frame-credentialed
        # request, but a click-on-overlay attack against the visible
        # send button needs frame denial. Apply to every response
        # uniformly — there is no legitimate same-origin iframe of
        # the bridge today.
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Content-Security-Policy", "frame-ancestors 'none'")
        # Belt-and-suspenders against MIME sniffing on user-uploaded
        # media tokens. Defensive even though /media/ is auth-gated.
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        # Don't leak referrer to third-party links the user follows.
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        return resp

    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")

    @app.get("/runtime-config.js")
    async def runtime_config():
        """Tiny runtime-injected config the static HTML files read on every
        page load. Carries:
          - `CRC_CONFIG.httpsUrl` so the login/chat pages can auto-redirect
            HTTP visitors to the secure origin (mic + WebAuthn need HTTPS).
          - `CRC_ASSET_VERSION` — the bridge's CURRENT asset version. app.js
            reads this and compares it against the WS hello frame's
            `asset_version`. Because both come from the same server function
            and this file is no-store (refetched on every page load), the
            client and server can no longer drift out of sync the way they
            did when the version was hardcoded in app.js."""
        payload = {"httpsUrl": cfg.web_https_url}
        ver = _get_asset_version()
        body = (
            "window.CRC_CONFIG = " + json.dumps(payload) + ";\n"
            + "window.CRC_ASSET_VERSION = " + json.dumps(ver) + ";"
        )
        return Response(
            content=body,
            media_type="application/javascript",
            headers={"Cache-Control": "no-store, must-revalidate"},
        )

    @app.get("/debug", response_class=HTMLResponse)
    async def debug_page(_: None = Depends(require_auth)):
        """A static page that tries the same things the chat UI does — fetch
        ws-token, attempt a WebSocket connect — and shows the result on
        screen. Auth-gated: an unauthenticated tailnet peer should not be
        able to confirm the bridge is running or fingerprint its build.
        Users who are locked out should use `/refresh` (cache nuke,
        preserves cookie) or `/nuke` (heavier, also clears cookie); both
        are deliberately open."""
        html = """<!doctype html><meta charset=utf-8>
<title>Bridge debug</title>
<style>body{background:#1a1614;color:#ece1d2;font-family:monospace;padding:20px;line-height:1.4;font-size:14px}
.row{margin:8px 0;padding:8px 12px;border-radius:6px;background:#211c19;border:1px solid rgba(255,247,235,0.1)}
.ok{color:#7fa37a}.fail{color:#c97264}.warn{color:#d4a85a}
.btn{display:inline-block;margin-top:12px;padding:10px 16px;background:#0E6E6E;color:#fff;border:none;border-radius:8px;font:inherit;cursor:pointer}
</style>
<h2 style=color:#0E6E6E>Bridge connection diagnostic</h2>
<div id=out></div>
<button class=btn onclick=run()>Re-run</button>
<a class=btn style="background:transparent;border:1px solid #0E6E6E;color:#0E6E6E;text-decoration:none;margin-left:8px" href=/nuke>/nuke</a>
<script>
const out = document.getElementById('out');
function row(label, status, detail) {
  // Build the row via createElement / textContent so untrusted bytes in
  // `detail` (e.g. HTTP error response bodies, CacheStorage key names)
  // can't break out as HTML or script. innerHTML concatenation here was
  // an XSS class issue even though the detail values are mostly server-
  // controlled.
  const div = document.createElement('div');
  div.className = 'row';
  const b = document.createElement('b');
  b.textContent = label + ': ';
  const span = document.createElement('span');
  span.className = status;
  span.textContent = status.toUpperCase();
  div.append(b, span);
  if (detail) {
    div.appendChild(document.createElement('br'));
    const small = document.createElement('small');
    small.textContent = detail;
    div.appendChild(small);
  }
  out.appendChild(div);
}
async function run() {
  out.innerHTML = '';
  row('URL', 'ok', location.href);
  row('Protocol', location.protocol === 'https:' ? 'ok' : 'warn',
      location.protocol + ' — ' + (location.protocol === 'https:' ? 'secure' : 'mic/Face ID disabled'));
  row('Cookie crc_auth', document.cookie.indexOf('crc_auth=') >= 0 ? 'ok' : 'warn',
      document.cookie || '(none)');
  // 1) Fetch ws-token
  let token = '';
  try {
    const r = await fetch('/api/ws-token', { method: 'POST', headers: { 'X-CRC-Request': '1' } });
    if (r.ok) {
      const d = await r.json();
      token = d.token || '';
      row('POST /api/ws-token', 'ok', 'HTTP ' + r.status + ', token prefix: ' + token.slice(0, 20) + '…');
    } else {
      const t = await r.text();
      row('POST /api/ws-token', 'fail', 'HTTP ' + r.status + ' — ' + t.slice(0, 200));
    }
  } catch (e) {
    row('POST /api/ws-token', 'fail', e.message || String(e));
  }
  // 2) Try WS
  if (token) {
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = proto + '//' + location.host + '/ws?token=' + encodeURIComponent(token);
      row('WS attempt', 'warn', url.slice(0, 80) + '…');
      const ws = new WebSocket(url);
      let resolved = false;
      const done = new Promise((res) => {
        ws.onopen = () => { resolved = true; res('open'); };
        ws.onclose = (e) => { if (!resolved) res('closed code=' + e.code + ' reason=' + (e.reason || '')); };
        ws.onerror = () => { if (!resolved) res('error'); };
        setTimeout(() => { if (!resolved) res('timeout'); }, 4000);
      });
      const result = await done;
      try { ws.close(); } catch {}
      row('WS result', result === 'open' ? 'ok' : 'fail', result);
    } catch (e) {
      row('WS exception', 'fail', e.message || String(e));
    }
  } else {
    row('WS attempt', 'warn', 'skipped (no token)');
  }
  // 3) Service workers
  if ('serviceWorker' in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      row('Service workers', regs.length === 0 ? 'ok' : 'warn',
          regs.length + ' registered. ' + (regs.length ? 'Tap /nuke to clear.' : ''));
    } catch (e) { row('Service workers', 'fail', e.message); }
  }
  // 4) Caches
  if ('caches' in self) {
    try {
      const keys = await caches.keys();
      row('CacheStorage', keys.length === 0 ? 'ok' : 'warn', keys.length + ' caches: ' + JSON.stringify(keys));
    } catch (e) { row('CacheStorage', 'fail', e.message); }
  }
  row('Build version', 'ok', 'v=__ASSET_VERSION__');
}
run();
</script>"""
        # Substitute the asset_version placeholder so the diagnostic row
        # reflects the bridge's actual current version (not a stale
        # hardcoded string).
        html = html.replace("__ASSET_VERSION__", _get_asset_version())
        return HTMLResponse(content=html, headers=_HTML_NO_CACHE)

    @app.get("/nuke", response_class=HTMLResponse)
    async def nuke(_: None = Depends(require_auth)):
        """Universal client-state nuke. Unregisters every service worker,
        deletes every cache, clears localStorage + sessionStorage, then
        force-reloads. Use this whenever the phone is stuck on a stale UI.
        Bookmarkable — same URL every time. Auth cookie also cleared at the
        HTTP layer so the next reload goes through /login fresh.

        Auth-gated to prevent any unauthenticated network peer (an extra
        Tailscale device, or anything reachable if the bridge is ever
        deployed outside Tailscale) from logging the user out. The
        truly-locked-out path is `/refresh` (unauth, preserves cookie) —
        or, if even the cookie is corrupt, delete the home-screen tile
        and reinstall via Safari's Share menu."""
        html = """<!doctype html><meta charset=utf-8>
<title>Resetting…</title>
<style>body{background:#1a1614;color:#ece1d2;font-family:sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;padding:20px;text-align:center}
h1{font-size:18px;color:#0E6E6E;margin:0 0 12px}
p{font-size:14px;color:#9a8f80;margin:6px 0;max-width:340px}
</style>
<h1>Resetting</h1>
<p id=status>Unregistering service workers...</p>
<script>
(async () => {
  const s = document.getElementById('status');
  try {
    // 1) Unregister every service worker we (or any prior version) installed.
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) { try { await r.unregister(); } catch {} }
    }
    s.textContent = 'Clearing caches...';
    // 2) Delete every CacheStorage entry.
    if ('caches' in self) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
    // 3) Wipe local + session storage.
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
    s.textContent = 'Reloading...';
    // 4) Force a fresh fetch by adding a unique query string Safari cannot
    //    have cached, then strip it on the next navigation.
    setTimeout(() => { location.replace('/login?fresh=' + Date.now()); }, 250);
  } catch (e) {
    s.textContent = 'Error: ' + (e && e.message ? e.message : e) + ' — tap to retry';
    s.onclick = () => location.reload();
  }
})();
</script>"""
        # Clear-Site-Data is the nuclear option: when Safari accepts this
        # header it wipes cookies, storage, caches, and service workers
        # for the origin synchronously. Combined with the client-side
        # script below, /nuke gives the user a single reliable escape
        # hatch from any stuck SW or cache state.
        nuke_headers = dict(_HTML_NO_CACHE)
        nuke_headers["Clear-Site-Data"] = '"cache", "cookies", "storage"'
        resp = HTMLResponse(content=html, headers=nuke_headers)
        resp.delete_cookie(AUTH_COOKIE)
        return resp

    @app.get("/refresh", response_class=HTMLResponse)
    async def refresh():
        """Stale-assets escape hatch that preserves auth.

        Hit by the in-app "Tap to reload" banner when client/server
        `asset_version` disagree. Returns a tiny redirect page with the
        `Clear-Site-Data` HTTP header set to wipe cache + storage but
        NOT cookies — so the user doesn't have to re-login every time
        the bridge ships a build. The redirect URL carries a
        `?fresh=<ts>` query string so iOS PWA standalone mode (which
        sometimes ignores `no-store` on the home-screen tile) is forced
        to fetch a distinct URL on the next navigation. Bookmarkable
        but normally invoked by JS.

        For the nuclear option that ALSO clears the auth cookie, use
        `/nuke`.
        """
        # Full-screen "rebuilding" overlay matching the in-app
        # _showRestartOverlay() pattern (animated coral spark + 18px
        # heading + 14px subtitle on the warm-dark canvas). Replaces an
        # older 14px "Refreshing…" stub that paints as plain text on the
        # white iOS Safari transition canvas during the brief window
        # before the meta-refresh fires — looked like a browser error
        # rather than intentional UX. Reported 2026-05-16.
        ts = int(time.time() * 1000)
        # Build the post-refresh URL with a freshly-stamped query value.
        # CRITICAL: we redirect directly to /c?b=r<ts>, NOT to /?fresh=<ts>.
        # Reason: when Safari's "A problem repeatedly occurred" page is
        # already showing for /c?b=<frozen_BUILD_ID>, sending the user to
        # / would 302 right back to that same blacklisted URL because
        # _BUILD_ID is per-process and frozen at module import. Going
        # straight to /c?b=r<ts> means every recovery attempt lands on a
        # URL Safari has never seen, so its per-URL error breaker can't
        # match. The `r` prefix makes the build stamp visibly distinct
        # from a startup-time one in case it shows up in screenshots.
        next_url = f"/c?b=r{ts}"
        # Viewport meta is REQUIRED — without it iOS Safari renders the
        # standalone /refresh page at a "desktop" 980px canvas and scales
        # everything down to fit, making the overlay appear tiny. The
        # in-app _showRestartOverlay() inherits index.html's viewport so
        # it doesn't suffer this; the standalone page needs its own.
        # Reported 2026-05-16.
        html = (
            '<!doctype html><html lang=en><meta charset=utf-8>'
            '<meta name=viewport content="width=device-width, initial-scale=1, viewport-fit=cover">'
            '<meta http-equiv=refresh content="0; url=' + next_url + '">'
            # JS escape hatch: if iOS Safari suppresses the meta-refresh
            # (it sometimes does in standalone PWA mode when the meta-tag
            # arrives after Clear-Site-Data wipes the document), force the
            # navigation from JS. setTimeout deferral lets the
            # Clear-Site-Data header settle first.
            '<script>setTimeout(function(){location.replace("' + next_url + '")},400);</script>'
            '<title>Updating…</title>'
            '<style>'
            'html,body{background:#1a1614;color:#ece1d2;'
            'font-family:Geist,system-ui,-apple-system,"Segoe UI",sans-serif;'
            'margin:0;padding:0;min-height:100dvh;'
            '-webkit-user-select:none;user-select:none;}'
            '.crc-update{position:fixed;inset:0;display:flex;flex-direction:column;'
            'align-items:center;justify-content:center;gap:18px;text-align:center;'
            'animation:fade 220ms ease-out;}'
            '.crc-update svg{width:48px;height:48px;color:#0E6E6E;'
            'animation:spin 1.4s linear infinite;}'
            '.crc-update h1{font-size:18px;font-weight:600;margin:0;line-height:1.4;}'
            '.crc-update p{margin:6px 0 0;font-size:14px;color:#c7bfb6;font-weight:400;'
            'max-width:240px;line-height:1.4;}'
            '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}'
            '@keyframes fade{from{opacity:0}to{opacity:1}}'
            '</style>'
            '<div class=crc-update>'
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
            '<path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6z"/>'
            '</svg>'
            '<div><h1>Updating Bridge…</h1>'
            '<p>Loading the new build. The chat will return in a moment.</p>'
            # Visible tappable fallback. If iOS Safari blocked the
            # automatic navigations (the WebKit "problem repeatedly
            # occurred" intercept matches by URL, but reaching THIS page
            # rules out a same-URL block; this link is for the rare case
            # where Clear-Site-Data resets the document state before any
            # nav handler can fire), the user can still escape with one
            # tap. Min-height 44px / 12px padding meets the touch target.
            '<a href="' + next_url + '" '
            'style="display:inline-block;margin-top:18px;padding:12px 22px;'
            'background:#0E6E6E;color:#fff;border-radius:999px;font-weight:600;'
            'text-decoration:none;font-size:15px;min-height:44px;line-height:20px;">'
            'Tap to continue</a></div>'
            '</div></html>'
        )
        headers = dict(_HTML_NO_CACHE)
        # Clear-Site-Data: ONLY "cache" — NOT "storage". Reason:
        #   - "cache" wipes the HTTP cache + CacheStorage API entries
        #     (which is what we want — stale HTML/JS/CSS goes away).
        #   - "storage" ALSO wipes localStorage / sessionStorage /
        #     IndexedDB / Service Worker registrations. Wiping
        #     localStorage destroys the user's persisted tab state
        #     (`crc.tabs`, `crc.activeProject`, `crc.theme`, etc.). The
        #     bug it caused: every /refresh recovery dropped the user
        #     back to a blank chat with no tabs even though the
        #     30-day TAB_RESTORE_TTL hadn't expired — they thought
        #     persistence was broken. Reported by user 2026-05-17.
        # The no-op service worker doesn't keep any state we need to
        # purge anyway, so dropping "storage" is safe.
        headers["Clear-Site-Data"] = '"cache"'
        return HTMLResponse(content=html, headers=headers)

    @app.get("/reset", response_class=HTMLResponse)
    async def reset():
        """Clears the auth cookie + sends back a self-redirecting page. Use
        this when the phone is wedged on a stale UI — it guarantees a clean
        login flow with fresh assets. Linked from CLAUDE.md."""
        resp = HTMLResponse(
            '<!doctype html><meta charset=utf-8><meta http-equiv=refresh content="0; url=/login">'
            '<title>resetting...</title>'
            '<style>body{background:#1a1614;color:#ece1d2;font-family:sans-serif;'
            'display:grid;place-items:center;min-height:100dvh;margin:0}</style>'
            '<div>Resetting… <a href="/login" style="color:#0E6E6E">tap if not redirected</a></div>',
            headers=_HTML_NO_CACHE,
        )
        resp.delete_cookie(AUTH_COOKIE)
        return resp

    # ── Client-crash telemetry ───────────────────────────────────────────
    #
    # iOS Safari can kill the WebContent process under memory pressure
    # without any visible error in the browser console. We can't ask the
    # phone "what happened" after the fact, so the client beacons here
    # on `window.onerror`, `unhandledrejection`, and `pagehide`. The body
    # is a small JSON blob: { kind, message, url, line, col, heap, tabs,
    # active, ts }. We log it server-side at INFO so the bridge stdout
    # gives us a forensic trail of pre-death client state.
    # Client-log file path. Bridge runs under pythonw.exe (no console
    # window) so stdout logs are invisible. Persisting to a dated file
    # under <repo>/logs/ gives the user something to `tail` and paste
    # back when iOS Safari crashes their page.
    _CLIENT_LOG_DIR = cfg.projects_root.parent / "logs"
    try:
        _CLIENT_LOG_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

    # /api/client-log rate-limiter state. Per-IP token bucket: each peer
    # gets 60 requests/minute. Above that the endpoint returns 204
    # WITHOUT writing — the legitimate phone never approaches this
    # ceiling (one beacon per error + one per pagehide), so any peer
    # exceeding it is misbehaving (loop-flood DoS). Auth-exempt is
    # required because sendBeacon can't carry custom headers, so the
    # rate-limit IS the abuse control.
    _CLIENT_LOG_BUCKETS: dict[str, list[float]] = {}
    _CLIENT_LOG_MAX_PER_MIN = 60
    # Per-file size cap. The bridge writes one log file per day; if a
    # file grows past 10 MB we rotate it to `<name>.old` (single
    # rotation only — old `.old` is overwritten) so the disk can't fill
    # under sustained abuse.
    _CLIENT_LOG_MAX_BYTES = 10 * 1024 * 1024

    @app.post("/api/client-log")
    async def client_log(request: Request):
        # No CSRF / auth gate by design: this endpoint accepts data even
        # when the client is mid-crash and `sendBeacon` cannot attach
        # custom headers. The rate-limit + size cap below are the
        # abuse controls.
        ip = request.client.host if request.client else "?"
        now = time.time()
        bucket = _CLIENT_LOG_BUCKETS.setdefault(ip, [])
        # Drop entries older than 60s.
        cutoff = now - 60.0
        while bucket and bucket[0] < cutoff:
            bucket.pop(0)
        if len(bucket) >= _CLIENT_LOG_MAX_PER_MIN:
            # Quietly drop — we still return 204 so a hostile peer can't
            # tell whether their requests are landing. Best-effort
            # silent throttling.
            return Response(status_code=204)
        bucket.append(now)
        try:
            raw = await request.body()
            if len(raw) > 8 * 1024:
                raw = raw[: 8 * 1024]
            text = raw.decode("utf-8", errors="replace")
            log.info("client-log %s", text)
            try:
                stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                path = _CLIENT_LOG_DIR / f"client-{datetime.now().strftime('%Y-%m-%d')}.log"
                # Size cap: rotate to `.old` (single rotation) if file
                # crosses 10 MB. Keeps disk usage bounded under sustained
                # abuse without losing the most recent ~10 MB of events.
                try:
                    if path.is_file() and path.stat().st_size > _CLIENT_LOG_MAX_BYTES:
                        rotated = path.with_suffix(path.suffix + ".old")
                        try:
                            if rotated.exists():
                                rotated.unlink()
                        except OSError:
                            pass
                        path.rename(rotated)
                except OSError:
                    pass
                with path.open("a", encoding="utf-8") as fh:
                    fh.write(f"{stamp} {text}\n")
            except OSError:
                # Best effort — disk full, perms, etc. shouldn't take
                # the bridge down.
                pass
        except Exception:
            log.exception("client-log handler failed")
        return Response(status_code=204)

    @app.get("/api/client-log/tail")
    async def client_log_tail(_: None = Depends(require_auth)):
        """Return the last ~50KB of today's client-log file as plain text.
        Auth-gated since it may contain stack traces with file paths."""
        path = _CLIENT_LOG_DIR / f"client-{datetime.now().strftime('%Y-%m-%d')}.log"
        if not path.is_file():
            return Response(content="(no log yet)\n", media_type="text/plain")
        try:
            data = path.read_bytes()[-50_000:]
            return Response(content=data, media_type="text/plain; charset=utf-8")
        except OSError as e:
            return Response(content=f"(read failed: {e})\n", media_type="text/plain")

    @app.get("/manifest.webmanifest")
    async def manifest():
        return FileResponse(_STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")

    @app.get("/sw.js")
    async def service_worker():
        # Must be served from root scope or its scope is restricted.
        return FileResponse(_STATIC_DIR / "sw.js", media_type="text/javascript")

    @app.get("/icons/{name}")
    async def icon(name: str):
        # Allowlist to avoid path traversal even though StaticFiles handles it
        # elsewhere — this route exists because iOS Safari fetches certain icon
        # URLs from root, not /static/.
        safe_name = Path(name).name
        # NTFS hardening, matching `_safe_upload_name`: drop alternate-
        # data-stream syntax (`foo.png:hidden`) and reserved device
        # names (CON, PRN, COM1…). Read-only `FileResponse` would 404 on
        # an ADS path anyway, but applying the same filter keeps the
        # NTFS guards consistent across every public file route.
        safe_name = safe_name.split(":", 1)[0].rstrip(". ")
        if not safe_name or safe_name.split(".", 1)[0].upper() in _NTFS_RESERVED:
            raise HTTPException(404)
        path = _STATIC_DIR / "icons" / safe_name
        if not path.is_file():
            raise HTTPException(404)
        return FileResponse(path)

    @app.get("/favicon.ico")
    async def favicon():
        return FileResponse(_STATIC_DIR / "icons" / "favicon.svg", media_type="image/svg+xml")

    # iOS Safari probes these root paths when "Add to Home Screen" is invoked
    # from contexts that don't parse the HTML <link> tags (e.g. a long-pressed
    # URL in Notes / Messages). Without these routes the OS falls back to a
    # cached apple-touch-icon for the same host — which on a laptop running
    # multiple PWAs becomes "wrong app's icon" surprise. Routing every probed
    # path to the 180px PNG is what Apple's own docs recommend.
    @app.get("/apple-touch-icon.png")
    @app.get("/apple-touch-icon-precomposed.png")
    @app.get("/apple-touch-icon-180x180.png")
    @app.get("/apple-touch-icon-180x180-precomposed.png")
    async def apple_touch_icon_root():
        return FileResponse(
            _STATIC_DIR / "icons" / "apple-touch-icon-180.png",
            media_type="image/png",
        )

    # ── WebSocket ────────────────────────────────────────────────────────

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        # FastAPI doesn't run cookie-Depends on WS, so check by hand. We
        # accept the auth token via EITHER the cookie OR a ?token=… query
        # param — the latter is the workaround for iOS Safari PWA mode,
        # which doesn't always send cookies on WSS upgrade. Same HMAC token
        # either way; no separate "ws credential."
        cookie = ws.cookies.get(AUTH_COOKIE)
        qtoken = ws.query_params.get("token")
        cookie_ok = _is_authed(cookie)
        token_ok = _is_authed(qtoken)
        log.info(
            "WS connect: cookie_ok=%s token_ok=%s client=%s",
            cookie_ok, token_ok,
            ws.client.host if ws.client else "?",
        )
        if not (cookie_ok or token_ok):
            # Surface auth failures at WARNING so they stand out in the
            # log when someone is probing. The happy path stays at INFO
            # above so normal traffic isn't shouted about.
            log.warning(
                "WS connect rejected: cookie_present=%s token_present=%s client=%s ua=%r",
                bool(cookie), bool(qtoken),
                ws.client.host if ws.client else "?",
                ws.headers.get("user-agent", "?"),
            )
            await ws.close(code=4401)
            return
        await ws.accept()

        outbound: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=WS_OUTBOUND_QSIZE)

        async def sender() -> None:
            # Catch every WS-related exception. iOS Safari on flaky
            # Tailscale can throw `ConnectionClosedError`,
            # `WebSocketState`-related runtime errors, or transport
            # `OSError` in addition to the textbook `WebSocketDisconnect`
            # / `RuntimeError`. Before this catch-all, those other
            # exceptions killed the sender silently, the `outbound`
            # queue filled to capacity, and every subsequent frame was
            # silently dropped — the user just saw a stale chat.
            try:
                while True:
                    frame = await outbound.get()
                    await ws.send_text(json.dumps(frame))
            except asyncio.CancelledError:
                raise
            except (WebSocketDisconnect, RuntimeError, ConnectionError, OSError):
                return
            except Exception:
                # Log loudly so we notice in dev; never re-raise — the
                # main receive loop has its own teardown path.
                log.exception("WS sender died unexpectedly; bailing")
                return

        sender_task = asyncio.create_task(sender())

        # If the sender task dies (e.g. uncaught WebSocket error), surface
        # it in the log so we don't silently leak frames to /dev/null.
        def _on_sender_done(t: asyncio.Task) -> None:
            if t.cancelled():
                return
            exc = t.exception()
            if exc is not None and not isinstance(exc, (WebSocketDisconnect, ConnectionError, OSError)):
                log.warning("WS sender finished with %s: %s", type(exc).__name__, exc)

        sender_task.add_done_callback(_on_sender_done)

        # Hello frame so the client can populate its UI without an extra REST round-trip.
        # `build_id` is the bridge's per-restart identity. The client
        # has its own version baked in at HTML load time (via the `?v=`
        # cache-bust query string) — if they disagree, the client is
        # running stale assets and we show a "reload required" banner.
        running = sessions.list_running()
        await outbound.put(msg(
            "hello",
            projects=list_projects(state.active_root),
            default_permission_mode=cfg.default_permission_mode,
            build_id=_BUILD_ID,
            asset_version=_get_asset_version(),
            running=[
                {"tab_id": tid, "project": project, "age_s": int(time.time() - started)}
                for tid, project, started in running
            ],
        ))

        # Keyed by a monotonic counter, not id(task) — id() can be recycled by
        # CPython after a task is collected, creating an aliasing race where
        # one task's done-callback removes a different task from the map.
        active_runs: dict[int, asyncio.Task[None]] = {}
        max_frame_bytes = cfg.web_max_ws_frame_kb * 1024

        try:
            while True:
                try:
                    raw = await ws.receive_text()
                except WebSocketDisconnect:
                    break
                if len(raw) > max_frame_bytes:
                    await outbound.put(msg(
                        "error",
                        error=f"Frame too large ({len(raw)} bytes > {max_frame_bytes} cap)",
                    ))
                    continue
                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    await outbound.put(msg("error", error="Bad JSON frame"))
                    continue
                if not isinstance(frame, dict):
                    await outbound.put(msg("error", error="Bad frame shape (object required)"))
                    continue
                await _handle_frame(
                    frame=frame, ws=ws, cfg=cfg, state=state, sessions=sessions,
                    outbound=outbound, active_runs=active_runs,
                    register_media=_register_media,
                    push_notify=_push_notify_run_finished,
                )
        finally:
            # IMPORTANT: do NOT cancel `active_runs` on WS disconnect.
            #
            # Earlier the bridge cancelled every run-task here, on the
            # theory that "the subprocess keeps running anyway." That was
            # wrong on two counts:
            #
            #  (a) Cancelling the run task cancels `await output_task`
            #      inside sessions.run → `was_cancelled = True` →
            #      outcome="stopped" → WebSink.run_finished's
            #      `if outcome == "done"` push gate fails → the phone
            #      never gets a notification when the run actually
            #      completes (which was the user's reported bug).
            #  (b) The subprocess's stdout has a finite OS-pipe buffer
            #      (~64KB on Windows). Once we stop draining it, claude
            #      blocks on its next write and stalls forever. On
            #      reconnect, a fresh `--resume` would read the stale
            #      output, re-running the spinner and producing the
            #      "you suddenly continued to work again" UX.
            #
            # The right behavior is to let the run task finish on its
            # own clock — it'll fire `run_finished` (and the push), and
            # the subprocess exits naturally. The sender_task still gets
            # cancelled because it owns the dead WS; frames go to the
            # outbound queue, fill it up, then drop with a warning (the
            # user replays from the on-disk jsonl when they reconnect).
            sender_task.cancel()
            try:
                await ws.close()
            except Exception:
                pass

    # Catch-all rescue handler. Without this, iOS Safari's data
    # detector can navigate the PWA to a phantom path (a date or file
    # path inside Claude's output that Safari turned into a tappable
    # link). FastAPI's default response is bare JSON, leaving the
    # user stranded on `{"detail":"not found"}`. Redirect any
    # text/html-accepting GET that didn't match a real route back to
    # the app root so the user lands back in the chat instead. API
    # / WS / media routes still return their normal 404s — we only
    # rescue browser-style GETs.
    @app.exception_handler(404)
    async def _on_404(request: Request, exc):  # type: ignore[unused-ignore]
        accept = request.headers.get("accept", "")
        path = request.url.path or "/"
        if request.method == "GET" and "text/html" in accept and not (
            path.startswith("/api/")
            or path.startswith("/media/")
            or path.startswith("/ws")
        ):
            return RedirectResponse(url="/", status_code=303)
        return JSONResponse({"detail": getattr(exc, "detail", "Not Found")}, status_code=404)

    return app


# ── Frame dispatch ───────────────────────────────────────────────────────

# Monotonic counter shared across all WS connections so active_runs keys can
# never collide (even across reconnects of the same client).
_RUN_KEY_COUNTER = 0


def _next_run_key() -> int:
    global _RUN_KEY_COUNTER
    _RUN_KEY_COUNTER += 1
    return _RUN_KEY_COUNTER


async def _handle_frame(
    *,
    frame: dict[str, Any],
    ws: WebSocket,
    cfg: Config,
    state: BridgeState,
    sessions: SessionManager,
    outbound: asyncio.Queue[dict[str, Any]],
    active_runs: dict[int, asyncio.Task[None]],
    register_media,
    push_notify=None,
) -> None:
    ftype = frame.get("type")

    if ftype == "ping":
        await outbound.put(msg("pong"))
        return

    if ftype == "prompt":
        await _do_prompt(
            frame=frame, cfg=cfg, state=state, sessions=sessions,
            outbound=outbound, active_runs=active_runs,
            register_media=register_media,
            push_notify=push_notify,
        )
        return

    if ftype == "command":
        await _do_command(
            frame=frame, cfg=cfg, state=state, sessions=sessions,
            outbound=outbound, active_runs=active_runs,
            register_media=register_media,
            push_notify=push_notify,
        )
        return

    if ftype == "stop":
        tab_id = (frame.get("tab_id") or "").strip()
        project = (frame.get("project") or "").strip()
        if not tab_id:
            await outbound.put(msg("error", error="stop frame missing tab_id"))
            return
        # If a project is included, validate it through the path jail (defense
        # in depth — sessions.stop currently only does a dict lookup, but if
        # it grows filesystem logic the validation is already in place).
        if project:
            try:
                resolve_project(state.active_root,project)
            except ProjectNotFound as e:
                await outbound.put(msg("error", error=str(e)))
                return
        ok = await sessions.stop(tab_id)
        if not ok:
            # Only surface a "no running session" message when the stop
            # didn't actually stop anything. A successful stop fires
            # `run_finished(outcome='stopped')` AND the client has already
            # marked the user bubble as "Interrupted" optimistically —
            # adding a separate "Stopped." system bubble below was the
            # third UI signal for the same event, which the user found
            # noisy. Silent on success.
            await outbound.put(msg(
                "text", tab_id=tab_id, project=project or None,
                text="No running session for this tab.",
            ))
        return

    await outbound.put(msg("error", error=f"Unknown frame type: {ftype}"))


async def _do_prompt(
    *,
    frame: dict[str, Any],
    cfg: Config,
    state: BridgeState,
    sessions: SessionManager,
    outbound: asyncio.Queue[dict[str, Any]],
    active_runs: dict[int, asyncio.Task[None]],
    register_media,
    push_notify=None,
) -> None:
    text = (frame.get("text") or "").strip()
    project = (frame.get("project") or "").strip()
    tab_id = (frame.get("tab_id") or "").strip()
    mode = (frame.get("permission_mode") or cfg.default_permission_mode).strip().lower()
    effort = (frame.get("effort") or "high").strip().lower()
    attachments = frame.get("attachments") or []  # list of {path, name, mime, kind, url?}
    # `force_session_id` is set by the client when opening a past session
    # from the history sheet — it tells the bridge to adopt that claude
    # session UUID into this tab BEFORE the run, so --resume picks it up.
    force_session_id = frame.get("force_session_id") or None
    # `is_compact` is set by the client when firing an auto-compact prompt.
    # Routes to --no-session-persistence so the compact reads the current
    # session as context but does NOT fork into a fresh jsonl. The
    # compact_inplace endpoint then appends the boundary + summary into
    # the ORIGINAL session, keeping the user in-place with their chat
    # history visible above the boundary.
    is_compact = bool(frame.get("is_compact"))
    # Validate against the same UUID-ish shape other session-id endpoints
    # require (api_session_compact_inplace, api_session_messages). A
    # tampered frame can't shell-inject — argv is passed as a list, not
    # via shell=True — but a weird string causes claude.exe to exit
    # non-zero, which is annoying inconsistency.
    if force_session_id and not _SESSION_ID_RE.match(force_session_id):
        await outbound.put(msg("error", error="Invalid force_session_id"))
        return
    # Cross-project session-adoption guard. An authenticated client could
    # otherwise pass any session UUID and have `claude --resume` pull in a
    # conversation that belongs to a different project's cwd, leaking its
    # history into this tab and injecting a new prompt into that other
    # session's jsonl. The shape check above prevents argv injection but
    # not this. Defer this check until AFTER `cwd` is resolved (below),
    # but capture the validated id here so the resolved-cwd code path
    # can do the existence check before adopting it. Done as a deferred
    # variable so the existing return-after-validation flow is preserved.
    # `model` is the per-tab Claude model selection. Empty = use server's
    # CLAUDE_MODEL config default. Whitelist to known Anthropic model
    # families so a tampered frame can't request arbitrary strings.
    model_raw = (frame.get("model") or "").strip()
    if model_raw and not _is_valid_claude_model(model_raw):
        await outbound.put(msg("error", error=f"Invalid model: {model_raw}"))
        return
    model_override = model_raw or None

    # Per-tab subagent selection (--agent flag). Empty = use Claude's default
    # main thread. Validated against the same character class agent filenames
    # accept (.claude/agents/<name>.md) so a tampered frame can't smuggle in
    # extra argv tokens.
    agent_raw = (frame.get("agent") or "").strip()
    if agent_raw and not _AGENT_NAME_RE.match(agent_raw):
        await outbound.put(msg("error", error=f"Invalid agent name: {agent_raw}"))
        return
    agent_choice = agent_raw or None

    if not text and not attachments:
        await outbound.put(msg("error", error="Empty prompt"))
        return
    if not tab_id:
        await outbound.put(msg("error", error="Missing tab_id"))
        return
    if mode not in {"ask", "auto", "plan", "edits"}:
        await outbound.put(msg("error", error=f"Invalid permission_mode: {mode}"))
        return
    if effort not in {"low", "medium", "high", "xhigh", "max"}:
        await outbound.put(msg("error", error=f"Invalid effort: {effort}"))
        return
    if not project:
        await outbound.put(msg("error", error="Set an active project first."))
        return
    try:
        cwd = resolve_project(state.active_root,project)
    except ProjectNotFound as e:
        await outbound.put(msg("error", error=str(e)))
        return

    # Cross-project session-adoption guard (see force_session_id note
    # above). The session UUID must correspond to a jsonl file in THIS
    # project's session directory — otherwise we'd be telling claude to
    # resume a conversation from a different project's cwd.
    if force_session_id:
        sess_dir = find_session_dir(cwd)
        jsonl = sess_dir / f"{force_session_id}.jsonl" if sess_dir else None
        if not jsonl or not jsonl.is_file():
            await outbound.put(msg(
                "error",
                error="force_session_id does not belong to this project",
            ))
            return

    # CRITICAL: validate every attachment.
    #   - kind="file" (upload): path MUST be inside <project>/.web-uploads/
    #   - kind="context"      : path MUST be inside the project's cwd (the
    #                           /api/context endpoint already enforced this,
    #                           but defense-in-depth — re-check here)
    #   - kind="url"          : no path; the `url` field carries the value
    # Without these checks a tampered WS frame could point at any file on
    # disk (e.g. .env.local) and claude would read it and stream contents back.
    upload_dir = _uploads_dir_for(cfg.projects_root, project).resolve()
    project_root = cwd.resolve()
    validated_attachments: list[dict[str, Any]] = []
    for a in attachments:
        kind = a.get("kind") or "file"
        if kind == "url":
            url = a.get("url")
            if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
                await outbound.put(msg("error", error="Invalid URL attachment"))
                return
            validated_attachments.append({**a, "kind": "url", "url": url})
            continue
        raw_path = a.get("path")
        if not isinstance(raw_path, str):
            await outbound.put(msg("error", error="Attachment missing path"))
            return
        try:
            ap = Path(raw_path).resolve()
        except (OSError, ValueError):
            await outbound.put(msg("error", error="Invalid attachment path"))
            return
        if kind == "file" or kind == "image":
            try:
                ap.relative_to(upload_dir)
            except ValueError:
                await outbound.put(msg(
                    "error",
                    error=f"Attachment path is outside the uploads folder",
                ))
                return
        else:
            # `context` attachments — files inside the project root.
            try:
                ap.relative_to(project_root)
            except ValueError:
                await outbound.put(msg(
                    "error",
                    error=f"Attachment path is outside {project_root}",
                ))
                return
        if not ap.is_file():
            await outbound.put(msg("error", error="Attachment file does not exist"))
            return
        validated_attachments.append({**a, "kind": kind, "path": str(ap)})

    final_prompt = _build_prompt(text=text, attachments=validated_attachments, cwd=cwd)

    sink = WebSink(
        outbound,
        tab_id=tab_id,
        max_media_mb=cfg.max_media_mb,
        media_url_for=register_media,
        push_notify=push_notify,
    )

    # Sending a fresh prompt IS the resume signal for a previously
    # paused session. Clear the pause flag so the messages-poll on the
    # reopened tab starts surfacing events again. We clear under either
    # the explicit force_session_id (history-resume path) or the tab's
    # current session_id (continuing-in-place path) — both apply
    # depending on how the user got back to this tab.
    sess_for_resume = sessions.sessions.get(tab_id)
    if sess_for_resume and sess_for_resume.session_id:
        state.paused_sessions.discard((project, sess_for_resume.session_id))
    if force_session_id:
        state.paused_sessions.discard((project, force_session_id))

    # Fire-and-forget the run on this WS — if the user disconnects, the
    # run itself keeps going (subprocess survives) but the task that
    # pumps its output gets cancelled. Deliberate, so a phone going to
    # sleep mid-run doesn't kill the work — when it reconnects, the
    # /api/sessions/<p>/<id>/messages replay surfaces what it missed.
    task = asyncio.create_task(sessions.run(
        tab_id=tab_id,
        project=project,
        cwd=cwd,
        prompt=final_prompt,
        permission_mode=mode,
        sink=sink,
        effort=effort,
        force_session_id=force_session_id,
        model_override=model_override,
        agent=agent_choice,
        no_session_persistence=is_compact,
        # Previously cleanup_paths deleted every "ephemeral" attachment
        # right after the run finished — which made image attachments
        # invisible on session replay (user closes app, reopens, the
        # image chip is gone because the .web-uploads file is gone).
        # Now keep them. Disk growth is bounded in practice (mobile
        # uploads are small) and `<project>/.web-uploads/` can be
        # cleared manually if it ever balloons. The attachment chip on
        # replay can resolve the file via /media/<token> against the
        # surviving path.
        cleanup_paths=[],
    ))
    key = _next_run_key()
    active_runs[key] = task
    task.add_done_callback(lambda _t: active_runs.pop(key, None))


async def _do_command(
    *,
    frame: dict[str, Any],
    cfg: Config,
    state: BridgeState,
    sessions: SessionManager,
    outbound: asyncio.Queue[dict[str, Any]],
    active_runs: dict[int, asyncio.Task[None]],
    register_media,
    push_notify=None,
) -> None:
    cmd = (frame.get("cmd") or "").strip().lower()
    args = frame.get("args") or []

    if cmd == "projects":
        names = list_projects(state.active_root)
        if not names:
            await outbound.put(msg("text", text=f"No project folders found under {state.active_root}."))
        else:
            # list_running() returns (tab_id, project, started_at) — only
            # need the project name here for the "(running)" marker.
            running = {project for _, project, _ in sessions.list_running()}
            lines = [f"• {n}{' (running)' if n in running else ''}" for n in names]
            await outbound.put(msg("text", text="Projects:\n" + "\n".join(lines)))
        return

    if cmd == "sessions":
        running = sessions.list_running()
        if not running:
            await outbound.put(msg("text", text="No running sessions."))
        else:
            now = time.time()
            # list_running returns (tab_id, project, started_at) tuples now.
            lines = [f"• {project} — {now - t:.0f}s (tab {tid[:8]})" for tid, project, t in running]
            await outbound.put(msg("text", text="Running sessions:\n" + "\n".join(lines)))
        return

    if cmd == "stop":
        tab_id = (frame.get("tab_id") or "").strip()
        if not tab_id:
            await outbound.put(msg("error", error="stop needs tab_id"))
            return
        ok = await sessions.stop(tab_id)
        await outbound.put(msg(
            "text", tab_id=tab_id,
            text="Stopped." if ok else "No running session for this tab.",
        ))
        return

    if cmd == "new":
        # /new on the web side clears the tab's claude session_id so the
        # NEXT message starts a fresh conversation (no --resume). The
        # client already wiped its chatpane and showed the empty state
        # with a fresh greeting — we don't send a confirmation text
        # back because it would land in the just-cleared pane and ruin
        # the "fresh start" visual.
        tab_id = (frame.get("tab_id") or "").strip()
        if not tab_id:
            await outbound.put(msg("error", error="new needs tab_id"))
            return
        await sessions.reset(tab_id)
        return

    if cmd == "close_tab":
        # When the client closes a tab, drop the server-side Session record
        # AND stop any in-flight run for it. Frees the slot in our session
        # map and any underlying claude subprocess.
        tab_id = (frame.get("tab_id") or "").strip()
        if not tab_id:
            await outbound.put(msg("error", error="close_tab needs tab_id"))
            return
        await sessions.remove(tab_id)
        return

    if cmd == "status":
        running = sessions.list_running()
        lines = [
            f"Default workspace root: {cfg.projects_root}",
            f"Active workspace root: {state.active_root}",
            "Running sessions:",
        ]
        if running:
            lines.extend(
                f"  • {project} — {time.time() - t:.0f}s (tab {tid[:8]})"
                for tid, project, t in running
            )
        else:
            lines.append("  (none)")
        await outbound.put(msg("text", text="\n".join(lines)))
        return

    if cmd == "ask":
        question = " ".join(args).strip() or (frame.get("text") or "").strip()
        project = (frame.get("project") or "").strip()
        tab_id = (frame.get("tab_id") or "").strip()
        if not project:
            await outbound.put(msg("error", error="Set an active project first."))
            return
        if not tab_id:
            await outbound.put(msg("error", error="ask needs tab_id"))
            return
        if not question:
            await outbound.put(msg("error", error="Usage: /ask <question>"))
            return
        try:
            cwd = resolve_project(state.active_root,project)
        except ProjectNotFound as e:
            await outbound.put(msg("error", error=str(e)))
            return
        mode = (frame.get("permission_mode") or cfg.default_permission_mode).strip().lower()
        effort_a = (frame.get("effort") or "high").strip().lower()
        if effort_a not in {"low", "medium", "high", "xhigh", "max"}:
            effort_a = "high"
        sink = WebSink(
            outbound,
            tab_id=tab_id,
            max_media_mb=cfg.max_media_mb,
            media_url_for=register_media,
            push_notify=push_notify,
        )
        task = asyncio.create_task(sessions.ask(
            tab_id=tab_id, project=project, cwd=cwd, prompt=question,
            permission_mode=mode, sink=sink, effort=effort_a,
        ))
        key = _next_run_key()
        active_runs[key] = task
        task.add_done_callback(lambda _t: active_runs.pop(key, None))
        return

    await outbound.put(msg("error", error=f"Unknown command: /{cmd}"))


def _build_prompt(*, text: str, attachments: list[dict[str, Any]], cwd: Path) -> str:
    if not attachments:
        return text
    # Both `kind == "file"` and `kind == "image"` are mobile-UI uploads
    # that live under <project>/.web-uploads/. The client tags images as
    # `kind: 'image'` to drive its chip styling; for the prompt they
    # behave identically (claude reads them with the Read tool). Lumping
    # them together fixes a long-standing bug where uploaded images
    # were silently dropped from the prompt — they got saved to disk but
    # the prompt sent to claude never mentioned them, and on session
    # replay the jsonl had no `[image] name → path` line to extract.
    file_atts = [a for a in attachments if a.get("kind") in ("file", "image")]
    context_atts = [a for a in attachments if a.get("kind") == "context"]
    url_atts = [a for a in attachments if a.get("kind") == "url"]
    lines: list[str] = []
    if file_atts:
        lines.append(
            "The user uploaded file(s) via the mobile UI. Read them from these "
            "absolute paths with your Read tool:"
        )
        for a in file_atts:
            kind = "image" if str(a.get("mime", "")).startswith("image/") else "file"
            lines.append(f"  - [{kind}] {a.get('name')} → {a.get('path')}")
        save_dir = cwd / "assets"
        lines.append("")
        lines.append(
            f"These files live under <project>/.web-uploads/ and persist so the "
            f"user can see them on session replay. If the user explicitly asks "
            f"you to save one into the project proper, copy it to {save_dir} "
            f"BEFORE you finish. Don't volunteer to save."
        )
        lines.append("")
    if context_atts:
        lines.append(
            "The user attached file(s) from the project as context. Read them "
            "with your Read tool BEFORE answering. These files are part of the "
            "project — do NOT delete them."
        )
        for a in context_atts:
            lines.append(f"  - {a.get('name')} → {a.get('path')}")
        lines.append("")
    if url_atts:
        lines.append(
            "The user wants you to consult these URL(s). Use your WebFetch "
            "tool to read them BEFORE answering:"
        )
        for a in url_atts:
            lines.append(f"  - {a.get('url')}")
        lines.append("")
    lines.append("User's message:")
    lines.append(text if text else "(no message — please address the attachments above)")
    return "\n".join(lines)
