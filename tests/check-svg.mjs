// Checks SVG import in this openscad build: orientation (mirroring),
// units (mm via width/viewBox) and fill-rule="evenodd" handling (holes).
import { createServer } from "http";
import { readFileSync } from "fs";
import { join, extname } from "path";
import { pathToFileURL } from "url";

const MIME = { ".js": "text/javascript", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
    try {
        const d = readFileSync(join("/dist", req.url.split("?")[0].slice(1) || "index.html"));
        res.writeHead(200, { "content-type": MIME[extname(req.url)] ?? "application/octet-stream" });
        res.end(d);
    } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8123, "127.0.0.1", r));
const { default: OpenSCAD } = await import(pathToFileURL("/dist/openscad.js").href);

// A 20×20 square in mm coordinates; an asymmetric notch in the top-left
// corner (in SVG y grows down): if the import doesn't mirror, the notch
// ends up at the maximum y.
const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">
  <path d="M 0 0 L 20 0 L 20 20 L 0 20 Z
           M 2 2 L 8 2 L 2 8 Z"
        fill="black" fill-rule="evenodd"/>
</svg>`;

const instance = await OpenSCAD({
    noInitialRun: true,
    locateFile: (p) => `http://127.0.0.1:8123/${p}`,
    print: (t) => console.log("[out]", t),
    printErr: (t) => console.log("[log]", t),
});
instance.FS.mkdir("/locale");
instance.FS.writeFile("/contour.svg", svg);
instance.FS.writeFile("/in.scad", `
linear_extrude(height = 5)
    import("contour.svg", center = false);
`);
const code = instance.callMain(["/in.scad", "-o", "/o.stl"]);
console.log("exit:", code);
const stl = new TextDecoder().decode(instance.FS.readFile("/o.stl"));

let xmin = 1e9, xmax = -1e9, ymin = 1e9, ymax = -1e9, zmax = -1e9, count = 0;
for (const m of stl.matchAll(/vertex (\S+) (\S+) (\S+)/g)) {
    const [x, y, z] = [+m[1], +m[2], +m[3]];
    count++;
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    if (z > zmax) zmax = z;
}
// the "notch" (triangle 2,2..8,2..2,8 in SVG coordinates) — a hole (evenodd)
console.log(`vertices ${count} | x ${xmin.toFixed(2)}..${xmax.toFixed(2)} | ` +
    `y ${ymin.toFixed(2)}..${ymax.toFixed(2)} | z max ${zmax.toFixed(2)}`);
server.close();
