"""Local Whisper transcription for the mic button.

Audio bytes arrive at /api/transcribe as the raw request body (NOT
multipart — the route reads straight off request.stream() to keep
audio strictly in RAM; multipart would route through Starlette's
UploadFile which spools >1MB payloads to a tempfile). They are decoded
+ transcribed entirely in memory via faster-whisper (which uses
PyAV/ffmpeg for container handling), and only the resulting *text*
is returned. The raw audio lives only in the request-scope bytes
object and is GC'd when the request finishes — no disk write at any
layer of the stack.

The model is lazy-loaded on first request so bridge startup stays
fast. After load it stays in RAM. Model + compute_type are
configurable via env:

  WHISPER_MODEL        default "base.en"   (tiny.en/base.en/small.en/...)
  WHISPER_COMPUTE_TYPE default "int8"      (int8 on CPU is the right
                                            quality/speed trade-off)
  WHISPER_DEVICE       default "cpu"       ("cuda" if you have a GPU)
  WHISPER_LANG         default ""          (empty = auto from model)
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import threading
from typing import Any

log = logging.getLogger(__name__)

_model_lock = threading.Lock()
_model: Any = None  # faster_whisper.WhisperModel — typed Any to avoid import at module load

# Bound concurrent Whisper invocations to 1 in-flight at a time. Each
# transcribe is CPU-bound; running multiple in parallel on the same
# laptop just thrashes the same cores. A semaphore keeps the queue
# orderly and prevents an authed client (or a stolen cookie) from
# pinning every core by spamming requests. Async semaphore so awaiting
# tasks don't block the event loop.
_inflight: asyncio.Semaphore | None = None


def _get_semaphore() -> asyncio.Semaphore:
    global _inflight
    if _inflight is None:
        _inflight = asyncio.Semaphore(1)
    return _inflight


class TranscribeError(RuntimeError):
    pass


def _load_model() -> Any:
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        try:
            from faster_whisper import WhisperModel  # type: ignore
        except ImportError as e:
            raise TranscribeError(
                "faster-whisper is not installed. Run "
                "`pip install faster-whisper` (or reinstall requirements.txt)."
            ) from e
        name = os.getenv("WHISPER_MODEL", "base.en").strip() or "base.en"
        device = os.getenv("WHISPER_DEVICE", "cpu").strip() or "cpu"
        compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "int8").strip() or "int8"
        log.info("[whisper] loading model=%s device=%s compute_type=%s", name, device, compute_type)
        _model = WhisperModel(name, device=device, compute_type=compute_type)
        log.info("[whisper] model ready")
        return _model


def _transcribe_sync(data: bytes, *, partial: bool) -> str:
    model = _load_model()
    lang = os.getenv("WHISPER_LANG", "").strip() or None
    # faster-whisper accepts a BinaryIO and decodes it with PyAV (which
    # speaks every container ffmpeg does: webm/opus from Chrome, mp4/aac
    # from iOS Safari, ogg/opus from Firefox). No tempfile needed.
    bio = io.BytesIO(data)
    segments, info = model.transcribe(
        bio,
        language=lang,
        # VAD filter (Silero) costs ~50-100ms per request — worth it for
        # the canonical final transcript but skipped on partials so live
        # text appears faster while the user is still speaking.
        vad_filter=not partial,
        beam_size=1,
        # Punctuation is the difference between "hey can you help me with this"
        # and "Hey, can you help me with this?" — the latter is what the
        # user expects when dictating into a chat composer.
        condition_on_previous_text=False,
    )
    parts: list[str] = []
    for seg in segments:
        parts.append(seg.text)
    text = "".join(parts).strip()
    log.info(
        "[whisper] transcribed %d bytes -> %d chars (lang=%s, duration=%.2fs, partial=%s)",
        len(data), len(text), info.language, info.duration, partial,
    )
    return text


async def transcribe_bytes(data: bytes, *, partial: bool = False) -> str:
    """Decode + transcribe audio bytes in-memory. Returns the recognized text.

    When `partial=True`, skips VAD filtering to shave per-request latency
    — used by the live-streaming poll loop while the user is still
    speaking. The final on-stop request keeps VAD on for clean text.

    Inflight calls are serialized via a module-level semaphore — Whisper
    is CPU-bound and running multiple instances in parallel just thrashes
    the same cores.
    """
    if not data:
        raise TranscribeError("Empty audio payload")
    async with _get_semaphore():
        try:
            return await asyncio.to_thread(_transcribe_sync, data, partial=partial)
        except TranscribeError:
            raise
        except Exception as e:  # noqa: BLE001 — surface decode/inference errors as 4xx
            log.exception("[whisper] transcription failed")
            raise TranscribeError(f"Transcription failed: {e}") from e
