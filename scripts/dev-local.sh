#!/bin/sh
set -eu

uv_bin="$(command -v uv)"
python_bin="$("$uv_bin" python find)"

# Vercel's builder uses uv while its local function emulator uses python3.
# Keep both on the pinned toolchain even when another Python is earlier on PATH.
PATH="$(dirname "$uv_bin"):$(dirname "$python_bin"):$PATH"
export PATH

# The dev server needs the linked project's settings, but not Vercel's
# background update and telemetry requests. Those requests can reset after the
# server is ready and take the long-running CLI process down with them.
NO_UPDATE_NOTIFIER=1
VERCEL_TELEMETRY_DISABLED=1
export NO_UPDATE_NOTIFIER VERCEL_TELEMETRY_DISABLED

exec npx --yes vercel@59.10.0 dev --listen 3000 "$@"
