#!/bin/sh
# Fast path for iterating on the example pages: copies example/www/** into
# dist/ with plain cp - no docker involved. The WASM artifacts are untouched,
# so a python http.server over dist/ picks the changes up immediately.
#
#   ./sync-www.sh        # after editing example/www/*.html or example/www/lib
#   ./build.sh           # only when the WASM artifacts themselves must change
set -eu

cd "$(dirname "$0")"

if [ ! -f dist/openscad.wasm ]; then
    echo "dist/ is not built yet - run ./build.sh once first" >&2
    exit 1
fi

cp example/www/viewer.html dist/index.html
cp example/www/heightmap.html dist/
rm -rf dist/lib dist/assets
cp -R example/www/lib dist/
cp -R example/www/assets dist/

echo ">> example pages synced to dist/ (wasm artifacts untouched)"
