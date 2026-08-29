# OpenSCAD WASM Port

A full port of OpenSCAD to WASM. 

This project cross compiles all of the project dependencies and created a headless OpenSCAD WASM module.

## Setup

Make sure that you have the following installed:

- Make
- Docker
- Deno

To build the project:

```
make all
```

Or for specific steps:

```
# Generate the library files
make libs 

# Build the project
make build

# Build the project in debug mode
make ENV=debug build
```

## Docker-only build

If you do not want to install Make/Deno/Node on the host machine, the whole
pipeline can run through Docker alone (fetching the pinned sources, building
the emscripten dependencies, cross-compiling OpenSCAD, bundling the JS runtime
and vendoring three.js for the example page):

```
./build.sh      # builds the image and extracts the artifacts into ./dist
./serve.sh      # serves the example page at http://localhost:8080
```

`build.sh` only invokes `docker` (plus `uname` to pick the right emsdk
architecture). Individual pipeline stages can be built for debugging, e.g.
`TARGET=libs ./build.sh` or `TARGET=openscad ./build.sh`.

## Using the artifacts without docker

Docker is only the *build* tool (and an optional serving convenience). The
`dist/` directory produced by `./build.sh` is self-contained and portable:
every reference in the page is relative, so it works from any directory root
with any static file server:

```
cd dist
python3 -m http.server 8000     # or any other static server
```

The requirements are just those of ES modules: the files must be served over
http(s) (opening `index.html` via `file://` does not work). Python's
`http.server` already sends the right MIME types, including
`application/wasm`.

While iterating on the example pages there is no need to rebuild anything -
`example/www/**` is plain HTML/JS, so just sync it into `dist/` and reload:

```
./sync-www.sh     # cp example/www/** into dist/, wasm artifacts untouched
```

Run `./build.sh` only when the WASM artifacts themselves must change (openscad
sources, dependencies, build flags); `serve.sh` should also be re-run then,
since the nginx image snapshots the files at build time.

To embed OpenSCAD into another project, copy the four core files (they must
stay together — the wrapper resolves `openscad.wasm` relative to itself) plus
the optional resource bundles:

```
openscad.js        # import this (ES6 module factory)
openscad.wasm.js   # emscripten glue
openscad.wasm      # the binary
openscad.fonts.js  # optional: fonts for text()
openscad.mcad.js   # optional: MCAD library
```

```js
import OpenSCAD from "./openscad.js";

const instance = await OpenSCAD({ noInitialRun: true });
instance.FS.writeFile("/input.scad", "cube(10);");
instance.callMain(["/input.scad", "--enable=manifold", "-o", "/out.stl"]);
const stl = instance.FS.readFile("/out.stl");  // Uint8Array
```

Any files a script needs (`surface(file = ...)` images, `use <...>` libraries)
are provided the same way — write them into the virtual FS with
`instance.FS.writeFile()` before `callMain`, as the example page does for
`assets/smiley.png`.

## MacOS

On MacOS, the version of Make that ships with the OS (3.81) is not compatible with this makefile, so you'll need to install a modern version of make and use that instead.

For instance, with homebrew:

`brew install gmake`

Depending on your PATH configuration, you may need to use `gmake` instead of `make` when running setup commands.

## Usage

There is an example project in the example folder. Run it using:

```
cd example
deno run --allow-net --allow-read server.ts

# or

make example
```

There are also automated tests that can be run using:

```
cd tests
deno test --allow-read --allow-write

# or

make test
```

## API

The project is an ES6 module. Simply import the module:

```ts
<html>
<head></head>
<body>

<script type="module">

import OpenSCAD from "./openscad.js";

// OPTIONAL: add fonts to the FS
import { addFonts } from "./openscad.fonts.js";

// OPTIONAL: add MCAD library to the FS
import { addMCAD } from "./openscad.mcad.js";

const filename = "cube.stl";

// Instantiate the application
const instance = await OpenSCAD({noInitialRun: true});

// Write a file to the filesystem
instance.FS.writeFile("/input.scad", `cube(10);`); // OpenSCAD script to generate a 10mm cube

// Run like a command-line program with arguments
instance.callMain(["/input.scad", "--enable=manifold", "-o", filename]); // manifold is faster at rendering

// Read the output 3D-model into a JS byte-array
const output = instance.FS.readFile("/"+filename);

// Generate a link to output 3D-model and download the output STL file
const link = document.createElement("a");
link.href = URL.createObjectURL(
new Blob([output], { type: "application/octet-stream" }), null);
link.download = filename;
document.body.append(link);
link.click();
link.remove();

</script>

</body>
</html>
```

For more information on reading and writing files check out the [Emscripten File System API](https://emscripten.org/docs/api_reference/Filesystem-API.html).
