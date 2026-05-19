#!/usr/bin/env bash
# One-time setup: create venv, install deps, copy .env.local.example.
# Run once from the repo root: ./scripts/setup.sh
set -euo pipefail

# This script lives in <repo>/scripts/. Walk up one level so venv,
# .env.local, requirements.txt, and bridge/ resolve at the repo root.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "$here")"
cd "$repo_root"

# Find a Python launcher: prefer `python3`, fall back to `python`.
py_cmd=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
        py_cmd="$candidate"
        break
    fi
done
if [ -z "$py_cmd" ]; then
    echo "No Python launcher found on PATH (tried: python3, python)." >&2
    echo "Install Python 3.11+ from https://www.python.org/downloads/ and re-run." >&2
    exit 1
fi
echo "Using Python launcher: $py_cmd"

echo "[1/3] Creating Python venv at ./.venv ..."
if [ ! -d ".venv" ]; then
    "$py_cmd" -m venv .venv
fi

echo "[2/3] Installing dependencies ..."
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements.txt

echo "[3/3] Checking .env.local ..."
if [ ! -f ".env.local" ]; then
    cp .env.local.example .env.local
    echo "    Created .env.local from template. Fill in PROJECTS_ROOT and WEB_PASSWORD before running ./scripts/start.sh."
else
    echo "    .env.local already exists; leaving it alone."
fi

echo ""
echo "Setup complete. Next:"
echo "  1. Open .env.local in a text editor and fill in:"
echo "     - PROJECTS_ROOT  (absolute path to the folder whose subfolders are your projects)"
echo "     - WEB_PASSWORD   (10+ chars; you'll type this once on your phone, then save it)"
echo "  2. Install Tailscale on this laptop AND your phone, sign both into the same tailnet."
echo "  3. Run ./scripts/start.sh, then on the phone visit http://<laptop-tailscale-name>:8787"
echo "     and Share -> Add to Home Screen for the PWA."
