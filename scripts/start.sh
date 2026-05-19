#!/usr/bin/env bash
# Launch the bridge. Run from the repo root: ./scripts/start.sh
# Ctrl+C to stop.
set -euo pipefail

# This script lives in <repo>/scripts/. Walk up one level so the bridge's
# venv + .env.local + bridge/ all resolve at the repo root.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "$here")"
cd "$repo_root"

if [ ! -x "./.venv/bin/python" ]; then
    echo "Venv not found. Run ./scripts/setup.sh first." >&2
    exit 1
fi
if [ ! -f "./.env.local" ]; then
    echo ".env.local not found. Run ./scripts/setup.sh and fill in the values." >&2
    exit 1
fi

./.venv/bin/python -m bridge.main
