// Smoke test for the built artifacts (runs inside a docker node container,
// see ./smoke.sh). The emscripten glue loads the WASM binary via fetch(),
// exactly like a browser does, so this serves ./dist over a local http server
// first and then renders a few models with the WASM binary, checking that the
// STL output is sane.
//
//   docker run --rm \
//       -v "$PWD/dist:/dist:ro" \
//       -v "$PWD/tests/smoke.mjs:/smoke.mjs:ro" \
//       node:22-slim node /smoke.mjs
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { pathToFileURL } from "url";

const DIST = "/dist";
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;

const MIME = {
    ".js": "text/javascript",
    ".wasm": "application/wasm",
    ".html": "text/html",
};

const server = createServer((req, res) => {
    try {
        const name = req.url.split("?")[0].replace(/^\//, "") || "index.html";
        const data = readFileSync(join(DIST, name));
        res.writeHead(200, {
            "content-type": MIME[extname(name)] ?? "application/octet-stream",
        });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end("not found");
    }
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const { default: OpenSCAD } = await import(pathToFileURL("/dist/openscad.js").href);

const models = {
    "cube.scad": "cube(10);",
    "sphere.scad": "$fn = 64; sphere(d = 20);",
    "csg.scad": `
difference() {
    intersection() {
        sphere(d = 32);
        cube([26, 26, 32], center = true);
    }
    cylinder(h = 40, d = 10, center = true);
}
`,
    // Docs examples 3a/3b: height map from the smiley PNG asset
    "surface.scad": `
translate([-55, 0, 0])
    scale([1, 1, 0.1])
        surface(file = "smiley.png", center = true);
translate([55, 0, 0])
    scale([1, 1, 0.1])
        surface(file = "smiley.png", center = true, invert = true);
`,
};

let failed = 0;

for (const [name, code] of Object.entries(models)) {
    try {
        const instance = await OpenSCAD({
            noInitialRun: true,
            locateFile: (path) => `${BASE}/${path}`,
            print: (t) => console.log(`[out] ${t}`),
            printErr: () => {},
        });

        // The surface() example reads the smiley PNG from the virtual FS,
        // exactly like the browser page does (it fetches ./assets/smiley.png).
        if (code.includes("smiley.png")) {
            const png = "/dist/assets/smiley.png";
            if (!existsSync(png)) throw new Error(`${png} missing - rebuild ./dist`);
            instance.FS.writeFile("/smiley.png", new Uint8Array(readFileSync(png)));
        }

        // Empty locale dir so openscad does not warn about missing translations
        // (and manifold is the default engine in this build, no flag needed).
        try { instance.FS.mkdir("/locale"); } catch { /* already there */ }

        instance.FS.writeFile("/input.scad", code);
        const t0 = performance.now();
        const exit = instance.callMain(["/input.scad", "-o", "/out.stl"]);
        if (exit !== 0) throw new Error(`exit code ${exit}`);

        const data = instance.FS.readFile("/out.stl");
        if (!(data instanceof Uint8Array) || data.length < 84) {
            throw new Error(`suspicious STL size: ${data?.length}`);
        }
        const header = String.fromCharCode(...data.slice(0, 5));
        // The uint32 at offset 80 is the triangle count only in binary STL;
        // ASCII STL (header "solid") has text there instead.
        const tris = header === "solid"
            ? "n/a (ascii)"
            : new DataView(data.buffer, data.byteOffset).getUint32(80, true);
        console.log(`OK   ${name}: ${data.length} bytes, header "${header}", ${tris} triangles, ` +
            `${Math.round(performance.now() - t0)} ms`);
    } catch (error) {
        failed++;
        console.error(`FAIL ${name}: ${error.message ?? error}`);
    }
}

server.close();
if (failed) {
    process.exit(1);
}
console.log("smoke test passed");
