#!/bin/sh
set -eu

uv_bin="$(command -v uv)"
python_bin="$("$uv_bin" python find)"

# Vercel's builder uses uv while its local function emulator uses python3.
# Keep both on the pinned toolchain even when another Python is earlier on PATH.
PATH="$(dirname "$uv_bin"):$(dirname "$python_bin"):$PATH"
export PATH

exec npx vercel dev --listen 3000 "$@"
