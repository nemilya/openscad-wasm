ENV ::= release
PTHREAD ::= 0
BUILDKIT ::= 0
EMSCRIPTEN_FLAGS := -fexceptions
DOCKER_EXTRA_ARGS :=

ifeq ($(strip $(ENV)),debug)
		CMAKE_BUILD_TYPE := Debug
		MESON_BUILD_TYPE := debug
		EMSCRIPTEN_FLAGS += -g -O0
else ifeq ($(strip $(ENV)),release)
		CMAKE_BUILD_TYPE := Release
		MESON_BUILD_TYPE := release
		EMSCRIPTEN_FLAGS += -O3
else ifeq ($(strip $(ENV)),minsize)
		CMAKE_BUILD_TYPE := MinSizeRel
		MESON_BUILD_TYPE := minsize
		EMSCRIPTEN_FLAGS += -Os
else
		$(error Bad ENV, must be release, minsize or debug)
endif

ifeq ($(PTHREAD),1)
    VARIANT = -pthread
    EMSCRIPTEN_FLAGS += -pthread 
# -sSHARED_MEMORY=1 -sPROXY_TO_PTHREAD=1 -sPTHREAD_POOL_SIZE=4
else
    VARIANT =
endif

DOCKER_TAG_BASE ?= openscad/wasm-base$(VARIANT)-$(ENV)
DOCKER_TAG_OPENSCAD ?= openscad/wasm$(VARIANT)-$(ENV)
DOCKER_OCI_BASE ?= .oci.wasm-base$(VARIANT)-$(ENV)

# Use the arm64 version of the emscripten sdk if running on an arm64 machine, as the amd64 image would crash QEMU in a couple of places.
# See latest version in https://hub.docker.com/r/emscripten/emsdk/tags
EMSCRIPTEN_VERSION ?= 6.0.5
UNAME_MACHINE := $(shell uname -m)
ifeq ($(UNAME_MACHINE),arm64)
    EMSCRIPTEN_SDK_TAG=emscripten/emsdk:$(EMSCRIPTEN_VERSION)-arm64
    CMAKE_TARBALL=https://github.com/Kitware/CMake/releases/download/v4.4.2/cmake-4.4.2-linux-aarch64.tar.gz
else
    EMSCRIPTEN_SDK_TAG=emscripten/emsdk:$(EMSCRIPTEN_VERSION)
    CMAKE_TARBALL=https://github.com/Kitware/CMake/releases/download/v4.4.2/cmake-4.4.2-linux-x86_64.tar.gz
endif

all: build

clean:
	rm -rf libs
	rm -rf build
	rm -rf .oci.* .*.make
	rm -rf runtime/dist runtime/node_modules

test:
	cd tests; deno test --allow-read --allow-write

.PHONY: example
example:
	cd example; deno run --allow-net --allow-read server.ts

.PHONY: build
build: build/openscad.wasm.js build/openscad.fonts.js

build/openscad.fonts.js: runtime/node_modules runtime/**/* res
	mkdir -p build
	cd runtime; npm run build
	cp runtime/dist/* build

runtime/node_modules:
	cd runtime; npm install

build/openscad.wasm.js: .image$(VARIANT)-$(ENV).make
	mkdir -p build
	docker rm -f tmpcpy
	docker run --name tmpcpy $(DOCKER_TAG_OPENSCAD)
	docker cp tmpcpy:/home/build/openscad.js build/openscad.wasm.js
	docker cp tmpcpy:/home/build/openscad.wasm build/
	docker cp tmpcpy:/home/build/openscad.wasm.map build/ || true
	docker rm tmpcpy

#
# Base image with emscripten and all the library dependencies
# for building OpenSCAD WASM.
#
.base-image$(VARIANT)-$(ENV).make: libs Dockerfile.base
ifeq ($(BUILDKIT),0)
	docker build libs \
		$(DOCKER_EXTRA_ARGS) \
		-f Dockerfile.base \
		-t $(DOCKER_TAG_BASE) \
		--build-arg "CMAKE_BUILD_TYPE=$(CMAKE_BUILD_TYPE)" \
		--build-arg "MESON_BUILD_TYPE=$(MESON_BUILD_TYPE)" \
		--build-arg "EMSCRIPTEN_FLAGS=$(EMSCRIPTEN_FLAGS)" \
		--build-arg "EMSCRIPTEN_SDK_TAG=$(EMSCRIPTEN_SDK_TAG)"
else
	docker buildx build libs \
		$(DOCKER_EXTRA_ARGS) \
		--progress plain \
		-f Dockerfile.base \
		-t $(DOCKER_TAG_BASE) \
		--build-arg "CMAKE_BUILD_TYPE=$(CMAKE_BUILD_TYPE)" \
		--build-arg "MESON_BUILD_TYPE=$(MESON_BUILD_TYPE)" \
		--build-arg "EMSCRIPTEN_FLAGS=$(EMSCRIPTEN_FLAGS)" \
		--build-arg "EMSCRIPTEN_SDK_TAG=$(EMSCRIPTEN_SDK_TAG)" \
		--output=type=oci,tar=false,dest="$(DOCKER_OCI_BASE)"
endif
	touch $@

#
#  Using the base image for building the OpenSCAD WASM binary.
#
.image$(VARIANT)-$(ENV).make: .base-image$(VARIANT)-$(ENV).make Dockerfile
ifeq ($(BUILDKIT),0)
	docker build libs/openscad \
		$(DOCKER_EXTRA_ARGS) \
		-f Dockerfile \
		-t $(DOCKER_TAG_OPENSCAD) \
		--build-arg "CMAKE_BUILD_TYPE=$(CMAKE_BUILD_TYPE)" \
		--build-arg "DOCKER_TAG_BASE=$(DOCKER_TAG_BASE)" \
		--build-arg "EMSCRIPTEN_FLAGS=$(EMSCRIPTEN_FLAGS)"
else
	docker buildx build libs/openscad \
		$(DOCKER_EXTRA_ARGS) \
		--progress plain \
		-f Dockerfile \
		-t $(DOCKER_TAG_OPENSCAD) \
		--pull=false \
		--load \
		--build-context $(DOCKER_TAG_BASE)="oci-layout://$(PWD)/$(DOCKER_OCI_BASE)" \
		--build-arg "CMAKE_BUILD_TYPE=$(CMAKE_BUILD_TYPE)" \
		--build-arg "DOCKER_TAG_BASE=$(DOCKER_TAG_BASE)" \
		--build-arg "EMSCRIPTEN_FLAGS=$(EMSCRIPTEN_FLAGS)"
endif
	touch $@

libs: \
	libs/cmake.tar.gz \
	libs/cairo \
	libs/cgal \
	libs/eigen \
	libs/fontconfig \
	libs/freetype \
	libs/libffi \
	libs/glib \
	libs/harfbuzz \
	libs/lib3mf \
	libs/libexpat \
	libs/liblzma \
	libs/libzip \
	libs/openscad \
	libs/boost \
	libs/gmp \
	libs/mpfr \
	libs/zlib \
	libs/libxml2 \
	libs/doubleconversion \
	libs/emscripten-crossfile.meson

# Every git dependency is pinned to an exact ref below, so that a build is
# reproducible and upstream churn cannot break it. Most are pinned to a release
# tag; the six upstreams that publish no usable tag are pinned to a commit SHA
# instead, which is why the clone helper below fetches a ref rather than using
# `git clone --branch` (that cannot check out a SHA).
#
# Set BLEEDING_EDGE=1 to build every git dependency from its upstream branch
# tip instead, to find out early what upstream is about to break:
#
#     gmake clean-libs
#     gmake BLEEDING_EDGE=1 build
#
# A single dependency can be moved without going all-in, e.g.
#
#     gmake OPENSCAD_REF=master build
#
# The boost/gmp/mpfr/cmake tarballs below are pinned by URL and are not
# affected by BLEEDING_EDGE.
#
BLEEDING_EDGE ?= 0

dep-ref = $(if $(filter 1,$(strip $(BLEEDING_EDGE))),$($(1)_TIP),$($(1)_REF))

# Release tags.
CAIRO_REF            ?= 1.18.4
CGAL_REF             ?= v6.0.3
DOUBLECONVERSION_REF ?= v3.4.0
EIGEN_REF            ?= 5.0.1
FONTCONFIG_REF       ?= 2.18.2
FREETYPE_REF         ?= VER-2-14-3
HARFBUZZ_REF         ?= 14.3.0
LIB3MF_REF           ?= v2.3.2
LIBEXPAT_REF         ?= R_2_8_2
LIBFFI_REF           ?= v3.7.1
LIBXML2_REF          ?= v2.15.3
LIBZIP_REF           ?= v1.11.4
ZLIB_REF             ?= v1.3.2

# These upstreams publish no usable release tag, so they stay pinned to the
# commit that was in use when they were pinned. Do not "simplify" these to a
# branch name: that is what left every dependency floating on master before.
#   openscad    nearest reachable tag is openscad-2019.05, 4002 commits back,
#               long predating any of the emscripten/wasm CMake support
#   glib        kleisauke fork, wasm-vips branch: no tags at all
#   liberation  shantigilbert mirror: no tags at all
#   liblzma     kobolabs fork: no tags at all
#   MCAD        newest tag is openscad-2019.05
GLIB_REF             ?= 3994b22020c9f61121ebbc902f19cfe906dd745b
LIBERATION_REF       ?= ef7161f03e305982b0b247e9a0b7cc472376dd83
LIBLZMA_REF          ?= 87b7682ce4b1c849504e2b3641cebaad62aaef87
MCAD_REF             ?= bd0a7ba3f042bfbced5ca1894b236cea08904e26
OPENSCAD_REF         ?= 04834adb1ba3c9a6e4160747c91cbadbce9c37b3

# Upstream branch tips, used when BLEEDING_EDGE=1. These are the repositories'
# default branches, except for glib (a fork, where only the wasm branch is
# useful) and zlib (whose default branch `develop` is the bleeding-edge one).
CAIRO_TIP            ?= master
CGAL_TIP             ?= main
DOUBLECONVERSION_TIP ?= master
EIGEN_TIP            ?= master
FONTCONFIG_TIP       ?= main
FREETYPE_TIP         ?= master
GLIB_TIP             ?= wasm-vips-2.89.3
HARFBUZZ_TIP         ?= main
LIB3MF_TIP           ?= master
LIBERATION_TIP       ?= master
LIBEXPAT_TIP         ?= master
LIBFFI_TIP           ?= master
LIBLZMA_TIP          ?= master
LIBXML2_TIP          ?= master
LIBZIP_TIP           ?= main
MCAD_TIP             ?= master
NOTO_TIP             ?= master
OPENSCAD_TIP         ?= master
ZLIB_TIP             ?= develop

# Shallow-clone $(2) into $(1) at exactly $(3). Uses init+fetch rather than
# `git clone --branch`, because the latter cannot check out a commit SHA.
define git-clone
mkdir -p $(1) && \
	git -C $(1) init -q && \
	{ git -C $(1) remote add origin $(2) 2>/dev/null || \
	  git -C $(1) remote set-url origin $(2); } && \
	git -C $(1) fetch --depth 1 origin $(3) && \
	git -C $(1) checkout --detach FETCH_HEAD
endef

define git-clone-recursive
$(call git-clone,$(1),$(2),$(3)) && \
	git -C $(1) submodule update -q --init --recursive --depth 1
endef

.PHONY: clean-libs
clean-libs:
	rm -rf libs res

libs/emscripten-crossfile.meson:
	mkdir -p libs
	cp emscripten-crossfile.meson $@

libs/cairo:
	$(call git-clone-recursive,$@,https://gitlab.freedesktop.org/cairo/cairo.git,$(call dep-ref,CAIRO))

libs/libffi:
	$(call git-clone,$@,https://github.com/libffi/libffi.git,$(call dep-ref,LIBFFI))

libs/cgal:
	$(call git-clone,$@,https://github.com/CGAL/cgal.git,$(call dep-ref,CGAL))

libs/eigen:
	$(call git-clone,$@,https://gitlab.com/libeigen/eigen.git,$(call dep-ref,EIGEN))

libs/fontconfig:
	$(call git-clone,$@,https://gitlab.freedesktop.org/fontconfig/fontconfig.git,$(call dep-ref,FONTCONFIG))

libs/freetype:
	$(call git-clone,$@,https://github.com/freetype/freetype.git,$(call dep-ref,FREETYPE))

libs/glib:
	$(call git-clone-recursive,$@,https://github.com/kleisauke/glib.git,$(call dep-ref,GLIB))

libs/harfbuzz:
	$(call git-clone,$@,https://github.com/harfbuzz/harfbuzz.git,$(call dep-ref,HARFBUZZ))

libs/lib3mf:
	$(call git-clone-recursive,$@,https://github.com/3MFConsortium/lib3mf.git,$(call dep-ref,LIB3MF))
	git -C $@ apply ../../patches/lib3mf.patch

libs/libexpat:
	$(call git-clone,$@,https://github.com/libexpat/libexpat,$(call dep-ref,LIBEXPAT))

libs/liblzma:
	$(call git-clone,$@,https://github.com/kobolabs/liblzma.git,$(call dep-ref,LIBLZMA))

libs/libzip:
	$(call git-clone,$@,https://github.com/nih-at/libzip.git,$(call dep-ref,LIBZIP))

libs/zlib:
	$(call git-clone,$@,https://github.com/madler/zlib.git,$(call dep-ref,ZLIB))

libs/libxml2:
	$(call git-clone,$@,https://gitlab.gnome.org/GNOME/libxml2.git,$(call dep-ref,LIBXML2))

libs/doubleconversion:
	$(call git-clone,$@,https://github.com/google/double-conversion,$(call dep-ref,DOUBLECONVERSION))

libs/openscad:
	$(call git-clone-recursive,$@,https://github.com/openscad/openscad.git,$(call dep-ref,OPENSCAD))

libs/boost:
	wget -O boost-1.87.0-b2-nodocs.tar.xz https://github.com/boostorg/boost/releases/download/boost-1.87.0/boost-1.87.0-b2-nodocs.tar.xz
	tar xf boost-1.87.0-b2-nodocs.tar.xz -C libs
	mv libs/boost-1.87.0 $@
	rm boost-1.87.0-b2-nodocs.tar.xz
	sed -i -E 's/-fwasm-exceptions/-fexceptions/g' libs/boost/tools/build/src/tools/emscripten.jam

libs/gmp:
	wget -O gmp-6.3.0.tar.xz https://gmplib.org/download/gmp/gmp-6.3.0.tar.xz
	tar xf gmp-6.3.0.tar.xz -C libs
	mv libs/gmp-6.3.0 $@
	rm gmp-6.3.0.tar.xz

libs/mpfr:
	wget -O mpfr-4.2.1.tar.xz https://www.mpfr.org/mpfr-4.2.1/mpfr-4.2.1.tar.xz
	tar xf mpfr-4.2.1.tar.xz -C libs
	mv libs/mpfr-4.2.1 $@
	rm mpfr-4.2.1.tar.xz

libs/cmake.tar.gz:
	mkdir -p libs
	wget -O $@ ${CMAKE_TARBALL}

res: \
	res/noto \
	res/liberation \
	res/MCAD

res/liberation:
	$(call git-clone-recursive,$@,https://github.com/shantigilbert/liberation-fonts-ttf.git,$(call dep-ref,LIBERATION))

res/noto:
	mkdir -p res/noto
	wget https://github.com/openmaptiles/fonts/raw/master/noto-sans/NotoSans-Regular.ttf -O res/noto/NotoSans-Regular.ttf
	wget https://github.com/openmaptiles/fonts/raw/master/noto-sans/NotoNaskhArabic-Regular.ttf -O res/noto/NotoNaskhArabic-Regular.ttf

res/MCAD:
	$(call git-clone,$@,https://github.com/openscad/MCAD.git,$(call dep-ref,MCAD))
