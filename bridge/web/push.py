"""Web Push for the bridge.

Sends "run finished" notifications to phones whose PWA has subscribed
via /api/push/subscribe. Works even when the PWA is fully closed because
the push is delivered by the browser's push service (FCM on Android,
Apple's APNS-backed mojo on iOS PWAs) directly to the device's
service worker (`bridge/web/static/sw.js`).

No third-party push relay. The bridge POSTs the encrypted payload
straight to whatever endpoint the browser handed us at subscribe time —
the only secret involved is the per-bridge VAPID key, auto-generated on
first run and persisted to `<projects_root>/.crc-push.json` alongside
the subscription list.

Single-user by design (matches the rest of the bridge): one bridge,
one VAPID keypair, N subscribed devices.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid
from pywebpush import WebPushException, webpush  # noqa: F401  (WebPushException kept for callers)

log = logging.getLogger(__name__)


# How long to keep dead subscriptions (HTTP 404 / 410 from the push
# endpoint) before pruning them out of the store. The browser issues
# fresh subscription endpoints fairly often, so an aggressive prune is
# fine; a too-aggressive one could throw away a subscription the user
# just made if a single send happened to flake.
_GONE_HTTP_STATUSES = {404, 410}

_PUSH_TTL_S = 86400  # 1 day — push services discard pending pushes after this


@dataclass
class _VapidKeys:
    private_pem: str
    public_b64url: str
    # Hydrated Vapid instance held alongside the PEM. pywebpush's
    # `vapid_private_key=` argument is documented to accept a Vapid
    # instance OR a string; the string path runs through
    # `Vapid.from_string`, which strips newlines and base64-url-decodes
    # the whole blob (including `-----BEGIN PRIVATE KEY-----`) — that
    # mangles a PEM-format string into invalid DER, raising
    # "Could not deserialize key data ... ASN.1 parsing error". Passing
    # the Vapid instance directly avoids the re-parse entirely.
    vapid: Vapid | None = None


class PushManager:
    """Owns the VAPID keypair, the subscription list, and the send loop.

    Persists to `<state_dir>/.crc-push.json` which has shape:

        {
          "vapid": {"private_pem": "...", "public_b64url": "..."},
          "subscriptions": [
            {"endpoint": "...", "keys": {"p256dh": "...", "auth": "..."},
             "added_at": 1700000000.0, "label": "iPhone"}
          ]
        }

    The file is created lazily on first subscribe / first send. If it
    doesn't exist when we boot, we still have keys in-memory; we just
    don't have subscribers yet.
    """

    def __init__(self, store_path: Path, vapid_email: str = "mailto:webpush@example.com") -> None:
        self._store_path = store_path
        # APNs (and FCM) reject VAPID JWTs whose `sub` host doesn't look
        # like a real domain — `bridge@localhost`, `bridge@bridge.local`,
        # etc. all come back as 403 BadJwtToken. example.com is reserved
        # (RFC 2606) and accepted universally; users can override via
        # `WEB_PUSH_EMAIL` in .env.local.
        if not vapid_email.startswith(("mailto:", "https:")):
            vapid_email = f"mailto:{vapid_email}"
        self._vapid_email = vapid_email
        self._keys: _VapidKeys = self._load_or_generate_keys()
        self._subs: list[dict[str, Any]] = self._load_subscriptions()

    # ── Public API ───────────────────────────────────────────────────

    @property
    def vapid_public_key(self) -> str:
        """URL-safe base64 of the VAPID public key — what the browser
        passes to `pushManager.subscribe({applicationServerKey})`."""
        return self._keys.public_b64url

    def add_subscription(self, subscription: dict[str, Any], *, label: str = "") -> None:
        """Persist a new subscription. Replaces ANY prior subscription with the
        same endpoint OR the same device label (user-agent) — single-user
        bridge means one device → one live subscription. Without label-dedup,
        every iOS PWA reinstall / VAPID-rotation / Safari data-clear left a
        stale endpoint behind; Apple silently accepted pushes (201) to dead
        endpoints, causing intermittent "sometimes notifications, sometimes
        not" — only the subset of the fanout that hit the LIVE endpoint
        actually rang the phone."""
        endpoint = subscription.get("endpoint")
        if not endpoint:
            return
        self._subs = [
            s for s in self._subs
            if s.get("endpoint") != endpoint
            and not (label and s.get("label") == label)
        ]
        entry = dict(subscription)
        entry["added_at"] = time.time()
        if label:
            entry["label"] = label
        self._subs.append(entry)
        self._save()

    def purge_stale(self, max_age_s: float = 30 * 86400) -> int:
        """Drop subscriptions older than max_age_s (default 30 days). Returns
        count removed. Apple Push services keep accepting (201) to long-dead
        endpoints, so age is the only reliable signal."""
        cutoff = time.time() - max_age_s
        before = len(self._subs)
        self._subs = [s for s in self._subs if s.get("added_at", 0) >= cutoff]
        removed = before - len(self._subs)
        if removed:
            self._save()
        return removed

    def remove_subscription(self, endpoint: str) -> None:
        before = len(self._subs)
        self._subs = [s for s in self._subs if s.get("endpoint") != endpoint]
        if len(self._subs) != before:
            self._save()

    def has_subscriptions(self) -> bool:
        return bool(self._subs)

    async def send(self, title: str, body: str, *, url: str = "/", tag: str = "crc-run-finished") -> None:
        """Fan-out a notification to every stored subscription.
        `pywebpush` is synchronous (uses `requests` under the hood);
        we run each send on a thread so the event loop stays free."""
        if not self._subs:
            return
        payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
        # Snapshot the list so concurrent add/remove don't mutate
        # underneath us while sends are in flight.
        snapshot = list(self._subs)
        results = await asyncio.gather(
            *(self._send_one(sub, payload) for sub in snapshot),
            return_exceptions=True,
        )
        gone: list[str] = []
        for sub, res in zip(snapshot, results):
            if isinstance(res, Exception):
                # WebPushException with `.response` carrying a status
                # tells us the subscription is dead and should be pruned.
                status = getattr(getattr(res, "response", None), "status_code", None)
                if status in _GONE_HTTP_STATUSES:
                    gone.append(sub.get("endpoint", ""))
                else:
                    log.warning("push send failed (status=%s): %s", status, res)
        if gone:
            self._subs = [s for s in self._subs if s.get("endpoint") not in gone]
            self._save()

    # ── Internals ────────────────────────────────────────────────────

    async def _send_one(self, sub: dict[str, Any], payload: str) -> None:
        await asyncio.to_thread(
            webpush,
            subscription_info={
                "endpoint": sub.get("endpoint"),
                "keys": sub.get("keys", {}),
            },
            data=payload,
            # Hand pywebpush the live Vapid instance so it skips its
            # own string→DER reparse, which truncates our PEM headers
            # and ASN.1-fails. See _VapidKeys docstring.
            vapid_private_key=self._keys.vapid,
            vapid_claims={"sub": self._vapid_email},
            ttl=_PUSH_TTL_S,
        )

    def _load_or_generate_keys(self) -> _VapidKeys:
        data = self._read_json()
        if data and isinstance(data.get("vapid"), dict):
            v = data["vapid"]
            priv = v.get("private_pem")
            pub = v.get("public_b64url")
            if isinstance(priv, str) and isinstance(pub, str) and priv and pub:
                vapid = Vapid.from_pem(priv.encode("ascii"))
                return _VapidKeys(private_pem=priv, public_b64url=pub, vapid=vapid)
        # Generate new keys.
        log.info("Generating new VAPID keypair for Web Push.")
        priv_key = ec.generate_private_key(ec.SECP256R1())
        priv_pem = priv_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode("ascii")
        # The Web Push spec wants the RAW public key (uncompressed point,
        # 65 bytes starting with 0x04) URL-safe-base64 encoded.
        pub_point = priv_key.public_key().public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
        pub_b64 = base64.urlsafe_b64encode(pub_point).rstrip(b"=").decode("ascii")
        vapid = Vapid.from_pem(priv_pem.encode("ascii"))
        keys = _VapidKeys(private_pem=priv_pem, public_b64url=pub_b64, vapid=vapid)
        # Persist immediately so a bridge restart doesn't invalidate
        # existing subscriptions.
        self._save_keys(keys)
        return keys

    def _load_subscriptions(self) -> list[dict[str, Any]]:
        data = self._read_json()
        subs = data.get("subscriptions") if data else None
        if isinstance(subs, list):
            return [s for s in subs if isinstance(s, dict) and s.get("endpoint")]
        return []

    def _read_json(self) -> dict[str, Any]:
        try:
            with self._store_path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

    def _save(self) -> None:
        data = self._read_json()
        data["vapid"] = {
            "private_pem": self._keys.private_pem,
            "public_b64url": self._keys.public_b64url,
        }
        data["subscriptions"] = self._subs
        self._atomic_write(data)

    def _save_keys(self, keys: _VapidKeys) -> None:
        data = self._read_json()
        data["vapid"] = {"private_pem": keys.private_pem, "public_b64url": keys.public_b64url}
        data.setdefault("subscriptions", [])
        self._atomic_write(data)

    def _atomic_write(self, data: dict[str, Any]) -> None:
        tmp = self._store_path.with_suffix(self._store_path.suffix + ".tmp")
        try:
            self._store_path.parent.mkdir(parents=True, exist_ok=True)
            with tmp.open("w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
            os.replace(tmp, self._store_path)
        except OSError as e:
            log.warning("Could not persist push store at %s: %s", self._store_path, e)


# Construct lazily (the test path doesn't always have a writable state dir).
def build_push_manager(state_dir: Path, vapid_email: str = "mailto:webpush@example.com") -> PushManager:
    return PushManager(state_dir / ".crc-push.json", vapid_email=vapid_email)
