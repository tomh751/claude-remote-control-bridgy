"""Filesystem watcher: forwards newly-created media files in a project's
watched folders (assets/, output/, screenshots/) to the phone chat.

When claude writes an image (a generated chart, a screenshot, anything
an active run produces under one of WATCH_FOLDERS), this module's
coroutine sees the FS event, copies the file into the bridge's
media-token registry, and tells the active sink to emit a `media` frame.
The phone renders the image inline in the chat.

Uses `watchfiles.awatch` which is async, cross-platform, and uses native
inotify/FSEvents/ReadDirectoryChangesW under the hood.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Awaitable, Callable, Iterable

from watchfiles import Change, awatch

log = logging.getLogger(__name__)

# Only forward files matching these extensions. Anything else (.py, .json,
# random model weights, etc.) is ignored.
ALLOWED_EXTS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm"})

# Wait this long after seeing a new file before uploading. Lets the writer
# finish flushing — many image generators write the header first, then the
# rest of the file. Uploading mid-write produces a truncated image.
STABILIZE_DELAY = 1.5


async def watch_project(
    *,
    cwd: Path,
    folders: Iterable[str],
    on_file: Callable[[Path], Awaitable[None]],
) -> None:
    """Watch `cwd/<folder>` for each folder in `folders` and call `on_file` for
    each new media file. Runs forever; cancel the task to stop.
    """
    # Only watch directories that already exist. Earlier versions created
    # `assets/`, `output/`, `screenshots/` proactively in every project,
    # which cluttered projects that never wrote into them. Now: if the
    # project hasn't asked for them by creating them, we don't watch them.
    # claude itself will mkdir on first write inside the cwd, and the
    # watcher idles harmlessly until something appears.
    paths_to_watch: list[Path] = []
    for name in folders:
        p = cwd / name
        if p.is_dir():
            paths_to_watch.append(p)

    if not paths_to_watch:
        log.info("no watch folders for %s; watcher idle", cwd)
        # Sleep forever; caller will cancel us on session end.
        await asyncio.Event().wait()
        return

    pending: dict[Path, float] = {}
    # Track in-flight stabilize/upload tasks so the GC can't collect them
    # during the 1.5s stabilization sleep — see `asyncio.create_task` docs.
    in_flight: set[asyncio.Task[None]] = set()

    async def stabilize_and_upload(path: Path) -> None:
        # Sleep, then check that the file's size hasn't changed in the last
        # cycle. If it has, sleep again.
        try:
            await asyncio.sleep(STABILIZE_DELAY)
            try:
                last_size = path.stat().st_size
            except FileNotFoundError:
                return
            for _ in range(3):
                await asyncio.sleep(0.5)
                try:
                    cur_size = path.stat().st_size
                except FileNotFoundError:
                    return
                if cur_size == last_size:
                    break
                last_size = cur_size
            await on_file(path)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("watcher upload failed for %s", path)

    # Restart-with-backoff loop. Earlier versions logged and exited on any
    # non-Cancelled exception, leaving the project silently un-watched
    # for the rest of the session — the user had no way to know media
    # forwarding was dead. Now we sleep and retry, doubling the delay up
    # to a 60s cap so a persistent failure (permission flip, drive
    # ejected) doesn't burn CPU.
    backoff = 1.0
    while True:
        try:
            async for changes in awatch(*paths_to_watch, recursive=True):
                # Successful tick — any prior failure has been recovered.
                backoff = 1.0
                for change_type, path_str in changes:
                    if change_type not in (Change.added, Change.modified):
                        continue
                    path = Path(path_str)
                    if path.suffix.lower() not in ALLOWED_EXTS:
                        continue
                    if not path.is_file():
                        continue
                    # Debounce: ignore re-fires for the same file within 5s.
                    now = time.monotonic()
                    last = pending.get(path, 0.0)
                    if now - last < 5.0:
                        continue
                    pending[path] = now
                    # Prune entries older than the debounce window so a project
                    # that emits thousands of files over a long session doesn't
                    # pin every Path object forever.
                    if len(pending) > 256:
                        cutoff = now - 30.0
                        for k in [k for k, t in pending.items() if t < cutoff]:
                            pending.pop(k, None)
                    task = asyncio.create_task(stabilize_and_upload(path))
                    in_flight.add(task)
                    task.add_done_callback(in_flight.discard)
        except asyncio.CancelledError:
            for t in in_flight:
                t.cancel()
            raise
        except Exception:
            log.exception("watcher loop crashed; restarting in %.1fs", backoff)
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                for t in in_flight:
                    t.cancel()
                raise
            backoff = min(backoff * 2, 60.0)
