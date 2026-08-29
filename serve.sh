#!/bin/sh
# Serve the built example page with nginx inside docker:
#
#   ./build.sh && ./serve.sh     # then open http://localhost:8080
#
# Environment overrides: IMAGE (default openscad-wasm:local), PORT (8080).
set -eu

cd "$(dirname "$0")"

IMAGE="${IMAGE:-openscad-wasm:local}"
PORT="${PORT:-8080}"

echo ">> serving http://localhost:${PORT} (ctrl-c to stop)"
exec docker run --rm --name openscad-wasm-example -p "${PORT}:80" "$IMAGE"
