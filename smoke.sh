#!/bin/sh
# Smoke-test the built artifacts without a browser: run tests/smoke.mjs with
# node inside a docker container against ./dist. Docker-only, like build.sh.
set -eu

cd "$(dirname "$0")"

if [ ! -f dist/openscad.wasm ]; then
    echo "dist/openscad.wasm not found - run ./build.sh first" >&2
    exit 1
fi

exec docker run --rm \
    -v "$PWD/dist:/dist:ro" \
    -v "$PWD/tests/smoke.mjs:/smoke.mjs:ro" \
    node:22-slim node /smoke.mjs
