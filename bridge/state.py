"""In-memory bridge state. Lost on restart — that's fine.

Holds two things:
  - per-project asyncio locks used by `SessionManager` to serialize
    start/stop/replace of a project's run
  - the user's active workspace root (defaults to `cfg.projects_root` but
    the phone can switch it to any directory under their home, see
    `/api/workspace/set_root`). Allowed roots are tracked so a switched-
    away root stays valid for tabs that already resolved against it.

Earlier versions tracked per-chat permission modes and a sent-message
log for the Telegram transport's `/clear` command — both removed when
that transport was dropped (2026-05-13).
"""

from __future__ import annotations

import asyncio
from pathlib import Path


class BridgeState:
    """Single shared state object. Access is single-threaded (one asyncio loop)."""

    def __init__(self, default_root: Path) -> None:
        self._project_locks: dict[str, asyncio.Lock] = {}
        # Default workspace root is fixed at bridge boot (from
        # `.env.local PROJECTS_ROOT`). The active root is what NEW
        # project picks resolve against; user can switch it from the
        # phone. Reverts to default on bridge restart so the install
        # stays reproducible from .env.local.
        self.default_root: Path = default_root.resolve()
        self.active_root: Path = self.default_root
        # Every root the user has ever activated this session. New
        # values are appended on `set_active_root()`; the set is used
        # by API handlers to validate that a `root` query/body field
        # from the phone really matches a root the user vouched for
        # (not an arbitrary path snuck in by a malicious frame).
        self.allowed_roots: set[Path] = {self.default_root}
        # Sessions the user has explicitly stopped. Keyed by
        # `(project, session_id)`. When a session is in this set, the
        # `/api/sessions/<project>/<sid>/messages` endpoint returns no
        # NEW events even if the underlying jsonl has more — so closing
        # and reopening a paused tab cannot replay buffered output that
        # claude.exe wrote between the user's stop click and the kill
        # landing, AND cannot mirror events from a parallel VS Code
        # claude run on the same session. Cleared automatically when
        # the user sends a fresh prompt for that tab (the act of
        # prompting IS the resume signal). In-memory only — resets on
        # bridge restart, which matches the in-memory session map.
        self.paused_sessions: set[tuple[str, str]] = set()

    def project_lock(self, project: str) -> asyncio.Lock:
        lock = self._project_locks.get(project)
        if lock is None:
            lock = asyncio.Lock()
            self._project_locks[project] = lock
        return lock

    def set_active_root(self, path: Path) -> Path:
        """Switch the active workspace root. Caller must have already
        validated the path (existence, type, allowed location). Returns
        the resolved absolute path that was set."""
        resolved = path.resolve()
        self.allowed_roots.add(resolved)
        self.active_root = resolved
        return resolved
