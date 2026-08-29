#!/bin/sh
# Docker-only build of the OpenSCAD WASM pipeline.
#
# The single requirement on the host machine is `docker`: fetching the pinned
# sources, building the emscripten dependencies, cross-compiling OpenSCAD and
# bundling the JS runtime all happen inside containers driven by
# Dockerfile.pipeline. No make, deno, node or npm is needed on the host.
#
#   ./build.sh                 # build everything, extract artifacts to ./dist
#   JOBS=2 ./build.sh          # gentler on the CPU / laptop thermals
#
# Stages are built one at a time (BuildKit would otherwise compile several
# dependencies in parallel) and each stage's compile parallelism is capped at
# JOBS, so the host is not saturated for the whole multi-hour build.
#
# Environment overrides:
#   EMSCRIPTEN_VERSION  emsdk version (default 6.0.5)
#   IMAGE               image tag (default openscad-wasm:local)
#   JOBS                max compile jobs per stage (default 4)
#   STAGES              space-separated stage list to build up to
#                       (default: everything, see below)
set -eu

cd "$(dirname "$0")"

EMSCRIPTEN_VERSION="${EMSCRIPTEN_VERSION:-6.0.5}"
IMAGE="${IMAGE:-openscad-wasm:local}"
JOBS="${JOBS:-4}"

# In dependency order so every `docker build --target` hits the cache; the
# last stage assembles the runnable example image. Cairo/libexpat are not
# listed: they are not part of the final image (see Dockerfile.pipeline).
STAGES="${STAGES:-libs builder zlib libffi glib freetype libxml2 \
fontconfig harfbuzz eigen cgal gmp mpfr doubleconversion libzip lib3mf \
wasm-base openscad runtime www-vendor example}"

# Use the arm64 emsdk image on arm64 machines; the amd64 one would have to go
# through emulation and crashes QEMU in a couple of places (see Makefile).
case "$(uname -m)" in
    arm64 | aarch64)
        EMSCRIPTEN_SDK_TAG="emscripten/emsdk:${EMSCRIPTEN_VERSION}-arm64"
        CMAKE_TARBALL="https://github.com/Kitware/CMake/releases/download/v4.4.2/cmake-4.4.2-linux-aarch64.tar.gz"
        ;;
    *)
        EMSCRIPTEN_SDK_TAG="emscripten/emsdk:${EMSCRIPTEN_VERSION}"
        CMAKE_TARBALL="https://github.com/Kitware/CMake/releases/download/v4.4.2/cmake-4.4.2-linux-x86_64.tar.gz"
        ;;
esac

echo ">> sdk: ${EMSCRIPTEN_SDK_TAG} | compile jobs per stage: ${JOBS}" \
     "(lower it with JOBS=2 ./build.sh if the machine runs hot)"

for stage in $STAGES; do
    echo ">> building stage: ${stage}"
    if [ "$stage" = "example" ]; then
        # Only the final stage needs a tag; the rest just warm the build cache.
        docker build -f Dockerfile.pipeline \
            --target "$stage" \
            -t "$IMAGE" \
            --build-arg EMSCRIPTEN_SDK_TAG="$EMSCRIPTEN_SDK_TAG" \
            --build-arg CMAKE_TARBALL="$CMAKE_TARBALL" \
            --build-arg JOBS="$JOBS" \
            "$@" \
            .
    else
        docker build -f Dockerfile.pipeline \
            --target "$stage" \
            --build-arg EMSCRIPTEN_SDK_TAG="$EMSCRIPTEN_SDK_TAG" \
            --build-arg CMAKE_TARBALL="$CMAKE_TARBALL" \
            --build-arg JOBS="$JOBS" \
            "$@" \
            .
    fi
done

# Extract the build artifacts to ./dist so the WASM file is also available
# directly on the host filesystem (still using only docker, via docker cp).
echo ">> extracting artifacts to ./dist"
rm -rf dist
mkdir -p dist
cid="$(docker create "$IMAGE")"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker cp "$cid:/usr/share/nginx/html/." dist/
docker rm "$cid" >/dev/null
trap - EXIT
rm -f dist/50x.html  # default nginx error page, not part of the artifacts

echo ">> done:"
ls -lh dist
