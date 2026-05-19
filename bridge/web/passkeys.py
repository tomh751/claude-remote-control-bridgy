"""WebAuthn / passkey support for the mobile PWA.

Single-user-by-design: there's exactly one "account" — whoever knows
WEB_PASSWORD. Once they've authenticated with the password, they can
register one or more passkeys (one per device they care about). Future
logins on those devices use Face ID / Touch ID instead of the password.

Storage: a tiny JSON file at `<projects_root>/.crc-passkeys.json`. Each
entry holds the credential id, public key, sign counter, and a friendly
label. Lost the file → user logs in with password and re-registers.

The challenge-state for in-flight ceremonies (registration / authentication)
lives in-memory in `_pending_challenges`. A ceremony has 5 minutes before
its challenge expires. The challenge nonce itself is what binds the
ceremony — if the browser comes back with a different challenge, validation
fails.
"""

from __future__ import annotations

import base64
import json
import logging
import secrets
import time
from pathlib import Path
from typing import Any

from webauthn import (
    generate_registration_options,
    generate_authentication_options,
    verify_registration_response,
    verify_authentication_response,
)
from webauthn.helpers.structs import (
    PublicKeyCredentialDescriptor,
    UserVerificationRequirement,
    AuthenticatorSelectionCriteria,
    ResidentKeyRequirement,
    AuthenticatorAttachment,
)

log = logging.getLogger(__name__)

# The "user handle" on the WebAuthn side — single shared identity.
_USER_ID = b"crc-single-user"
_USER_NAME = "bridgy"
_USER_DISPLAY = "Bridgy"
CHALLENGE_TTL_S = 300  # 5 minutes


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


class PasskeyStore:
    """Disk-backed registry of registered credentials. Atomic-ish writes via
    temp-file-rename so a crash mid-save doesn't corrupt the file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._creds: list[dict[str, Any]] = []
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self._creds = data.get("credentials", [])
        except Exception:
            log.exception("Failed to load passkey store; starting empty")
            self._creds = []

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"credentials": self._creds}, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def list_credential_ids(self) -> list[bytes]:
        return [_b64url_decode(c["id"]) for c in self._creds]

    def lookup(self, credential_id: bytes) -> dict[str, Any] | None:
        cid = _b64url(credential_id)
        for c in self._creds:
            if c["id"] == cid:
                return c
        return None

    def labels(self) -> list[dict[str, Any]]:
        # Public-facing view: don't include the public key, just the metadata
        # the user needs to identify and revoke a registration.
        return [{"id": c["id"], "label": c.get("label", "Device"), "created_at": c.get("created_at")}
                for c in self._creds]

    def add(self, *, credential_id: bytes, public_key: bytes, sign_count: int, label: str) -> None:
        self._creds.append({
            "id": _b64url(credential_id),
            "public_key": _b64url(public_key),
            "sign_count": sign_count,
            "label": label,
            "created_at": int(time.time()),
        })
        self._save()

    def update_sign_count(self, credential_id: bytes, sign_count: int) -> None:
        cid = _b64url(credential_id)
        for c in self._creds:
            if c["id"] == cid:
                c["sign_count"] = sign_count
                self._save()
                return

    def remove(self, credential_id_b64: str) -> bool:
        before = len(self._creds)
        self._creds = [c for c in self._creds if c["id"] != credential_id_b64]
        if len(self._creds) != before:
            self._save()
            return True
        return False


class PasskeyManager:
    """Wraps the store + in-flight challenge state. One instance per bridge
    process; not threadsafe, but the bridge is asyncio single-threaded so
    that's fine."""

    def __init__(self, *, store_path: Path, rp_id: str, rp_name: str, origin: str) -> None:
        self.store = PasskeyStore(store_path)
        self.rp_id = rp_id          # e.g. "your-laptop.tailXXXX.ts.net" (Tailscale MagicDNS hostname)
        self.rp_name = rp_name      # "Bridgy"
        self.origin = origin        # full origin including scheme: "https://your-laptop.tailXXXX.ts.net"
        # challenge bytes → expires_at (unix). We key by the challenge itself
        # so two browsers can have parallel ceremonies without colliding.
        self._pending: dict[bytes, float] = {}

    def _sweep(self) -> None:
        now = time.time()
        self._pending = {k: v for k, v in self._pending.items() if v > now}

    # ── Registration ────────────────────────────────────────────────────

    def begin_registration(self) -> dict[str, Any]:
        """Generate a registration challenge. Returns the publicKey options
        the browser passes to navigator.credentials.create()."""
        self._sweep()
        exclude = [
            PublicKeyCredentialDescriptor(id=_b64url_decode(c["id"]))
            for c in self.store._creds
        ]
        opts = generate_registration_options(
            rp_id=self.rp_id,
            rp_name=self.rp_name,
            user_id=_USER_ID,
            user_name=_USER_NAME,
            user_display_name=_USER_DISPLAY,
            exclude_credentials=exclude,
            # Platform authenticator (Face ID / Touch ID / Windows Hello),
            # not roaming keys. Resident keys (passkeys) so user doesn't
            # have to remember which credential to use.
            authenticator_selection=AuthenticatorSelectionCriteria(
                authenticator_attachment=AuthenticatorAttachment.PLATFORM,
                resident_key=ResidentKeyRequirement.PREFERRED,
                user_verification=UserVerificationRequirement.PREFERRED,
            ),
        )
        self._pending[bytes(opts.challenge)] = time.time() + CHALLENGE_TTL_S

        # The webauthn helper returns dataclasses with `bytes` fields that
        # need base64url encoding for JSON transport. We hand-shape the
        # response to exactly what the browser's `navigator.credentials.create`
        # expects so we never have to deserialize on the client side.
        return {
            "rp": {"id": opts.rp.id, "name": opts.rp.name},
            "user": {
                "id": _b64url(opts.user.id),
                "name": opts.user.name,
                "displayName": opts.user.display_name,
            },
            "challenge": _b64url(opts.challenge),
            "pubKeyCredParams": [
                {"alg": p.alg, "type": p.type} for p in opts.pub_key_cred_params
            ],
            "timeout": opts.timeout,
            "excludeCredentials": [
                {"id": _b64url(c.id), "type": "public-key"} for c in (opts.exclude_credentials or [])
            ],
            "authenticatorSelection": {
                "authenticatorAttachment": "platform",
                "residentKey": "preferred",
                "userVerification": "preferred",
            },
            "attestation": "none",
        }

    def finish_registration(self, *, response_json: dict[str, Any], label: str) -> dict[str, Any]:
        """Verify the attestation the browser produced and persist the new
        credential. Returns a small description of the saved credential."""
        # Recover the original challenge from the clientDataJSON so we can
        # check it against our pending set.
        client_data_json = _b64url_decode(response_json["response"]["clientDataJSON"])
        client_data = json.loads(client_data_json.decode("utf-8"))
        expected_challenge = _b64url_decode(client_data["challenge"])
        if expected_challenge not in self._pending or time.time() > self._pending[expected_challenge]:
            raise ValueError("Registration challenge expired or unknown")
        verification = verify_registration_response(
            credential=response_json,
            expected_challenge=expected_challenge,
            expected_origin=self.origin,
            expected_rp_id=self.rp_id,
            require_user_verification=False,
        )
        self._pending.pop(expected_challenge, None)
        self.store.add(
            credential_id=verification.credential_id,
            public_key=verification.credential_public_key,
            sign_count=verification.sign_count,
            label=label or "Device",
        )
        return {
            "id": _b64url(verification.credential_id),
            "label": label or "Device",
        }

    # ── Authentication ──────────────────────────────────────────────────

    def begin_authentication(self) -> dict[str, Any]:
        """Generate an authentication challenge. The browser passes the
        returned options to navigator.credentials.get()."""
        self._sweep()
        creds = [PublicKeyCredentialDescriptor(id=cid) for cid in self.store.list_credential_ids()]
        opts = generate_authentication_options(
            rp_id=self.rp_id,
            allow_credentials=creds,
            user_verification=UserVerificationRequirement.PREFERRED,
        )
        self._pending[bytes(opts.challenge)] = time.time() + CHALLENGE_TTL_S
        return {
            "rpId": opts.rp_id,
            "challenge": _b64url(opts.challenge),
            "timeout": opts.timeout,
            "userVerification": "preferred",
            "allowCredentials": [
                {"id": _b64url(c.id), "type": "public-key"} for c in (opts.allow_credentials or [])
            ],
        }

    def finish_authentication(self, *, response_json: dict[str, Any]) -> dict[str, Any]:
        """Verify a Face ID / passkey assertion. On success, returns a small
        descriptor — the server then mints a session cookie like a normal login."""
        client_data_json = _b64url_decode(response_json["response"]["clientDataJSON"])
        client_data = json.loads(client_data_json.decode("utf-8"))
        expected_challenge = _b64url_decode(client_data["challenge"])
        if expected_challenge not in self._pending or time.time() > self._pending[expected_challenge]:
            raise ValueError("Authentication challenge expired or unknown")
        credential_id = _b64url_decode(response_json["id"])
        stored = self.store.lookup(credential_id)
        if stored is None:
            raise ValueError("Unknown credential")
        verification = verify_authentication_response(
            credential=response_json,
            expected_challenge=expected_challenge,
            expected_rp_id=self.rp_id,
            expected_origin=self.origin,
            credential_public_key=_b64url_decode(stored["public_key"]),
            credential_current_sign_count=stored.get("sign_count", 0),
            require_user_verification=False,
        )
        self._pending.pop(expected_challenge, None)
        # Anti-cloning: update the sign counter. A device that returns a
        # decreasing counter has been cloned.
        if verification.new_sign_count > stored.get("sign_count", 0):
            self.store.update_sign_count(credential_id, verification.new_sign_count)
        return {"id": _b64url(credential_id), "label": stored.get("label", "Device")}

    def has_credentials(self) -> bool:
        return bool(self.store._creds)
