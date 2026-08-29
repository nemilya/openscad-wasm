// "Stamp" check: where the smiley's eyes/smile end up — on the top plane
// of the relief (z=base+relief) or flush with the base plate (z=base).
import { createServer } from "http";
import { readFileSync } from "fs";
import { deflateSync } from "zlib";
import { join, extname } from "path";
import { pathToFileURL } from "url";

// --- the same raster example/gen-smiley.mjs generates ---
const W = 100, H = 100;
const px = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        let v = 255;
        for (const [cx, cy, r] of [[35, 38, 7], [65, 38, 7]]) {
            if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) v = 0; // eyes
        }
        const dx = x - 50, dy = y - 50, d = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        if (d >= 25 && d <= 31 && ang >= Math.PI / 4 && ang <= (3 * Math.PI) / 4) v = 0; // smile
        px[y * W + x] = v;
    }
}

// --- minimal grayscale-PNG encoder ---
function crc32(buf) {
    if (!crc32.t) {
        const t = crc32.t = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c;
        }
    }
    let c = 0xffffffff;
    for (const b of buf) c = crc32.t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}
function encodePng(raster) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 0;
    const raw = Buffer.alloc(H * (1 + W));
    for (let y = 0; y < H; y++) {
        raw[y * (1 + W)] = 0;
        Buffer.from(raster.buffer, y * W, W).copy(raw, y * (1 + W) + 1);
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
    ]);
}

// --- http server to load the wasm (as in the browser) ---
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

// The code heightmap.html generates in stamp mode
const scad = `
size_x = 60; size_y = 60; relief_h = 5; base_h = 2;
union() {
    cube([size_x, size_y, base_h]);
    translate([0, 0, base_h])
        scale([size_x / 100, size_y / 100, relief_h / 100])
            surface(file = "image.png", center = false, invert = false);
}`;

for (const [label, raster] of [
    ["inverted (stamp)", px.map((v) => 255 - v)],
    ["direct (engraving)", px],
]) {
    const instance = await OpenSCAD({
        noInitialRun: true,
        locateFile: (p) => `http://127.0.0.1:8123/${p}`,
        print: () => {}, printErr: () => {},
    });
    instance.FS.mkdir("/locale");
    instance.FS.writeFile("/image.png", encodePng(raster));
    instance.FS.writeFile("/input.scad", scad);
    instance.callMain(["/input.scad", "-o", "/out.stl"]);

    const stl = new TextDecoder().decode(instance.FS.readFile("/out.stl"));
    // 30x30 ASCII map: where the TOP-layer vertices sit (z > 5)
    const G = 30;
    const grid = Array.from({ length: G }, () => new Array(G).fill("·"));
    let topCount = 0;
    for (const m of stl.matchAll(/vertex (\S+) (\S+) (\S+)/g)) {
        const [x, y, z] = [+m[1], +m[2], +m[3]];
        if (z <= 5) continue;
        topCount++;
        const gx = Math.min(G - 1, Math.floor(x / 60 * G));
        const gy = Math.min(G - 1, Math.floor(y / 60 * G));
        grid[gy][gx] = "#";
    }
    console.log(`\n${label}: top-layer vertices (z>5): ${topCount}`);
    // printed as a table: row 0 at the top is y from 0 (bottom in OpenSCAD coordinates)
    for (let row = G - 1; row >= 0; row--) console.log("   " + grid[row].join(""));
}
server.close();
