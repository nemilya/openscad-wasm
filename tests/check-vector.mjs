// Checks the vector mode of heightmap.html: contour (marching squares + Chaikin)
// → SVG → linear_extrude. Key point: walls are strictly vertical — all relief
// vertices sit at z = base_h or base_h + relief_h, no intermediate heights.
import { createServer } from "http";
import { readFileSync } from "fs";
import { join, extname } from "path";
import { pathToFileURL } from "url";

/* ---- function copies from example/www/heightmap.html ---- */
function dilateDark(src, w, h, r) {
    if (r <= 0) return src;
    const tmp = new Uint8Array(src.length);
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let m = 255;
        for (let d = -r; d <= r; d++) {
            const v = src[y * w + Math.min(w - 1, Math.max(0, x + d))];
            if (v < m) m = v;
        }
        tmp[y * w + x] = m;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let m = 255;
        for (let d = -r; d <= r; d++) {
            const v = tmp[Math.min(h - 1, Math.max(0, y + d)) * w + x];
            if (v < m) m = v;
        }
        dst[y * w + x] = m;
    }
    return dst;
}

function boxBlur(src, w, h, r, passes = 2) {
    let a = src, b = new Uint8Array(src.length);
    const win = 2 * r + 1;
    for (let p = 0; p < passes; p++) {
        for (let y = 0; y < h; y++) {
            let sum = src[y * w] * (r + 1);
            for (let d = 1; d <= r; d++) sum += src[y * w + Math.min(w - 1, d)];
            for (let x = 0; x < w; x++) {
                b[y * w + x] = Math.round(sum / win);
                sum += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
            }
        }
        const t = a; a = b; b = t === src ? new Uint8Array(src.length) : t;
        for (let x = 0; x < w; x++) {
            let sum = a[x] * (r + 1);
            for (let d = 1; d <= r; d++) sum += a[Math.min(h - 1, d) * w + x];
            for (let y = 0; y < h; y++) {
                b[y * w + x] = Math.round(sum / win);
                sum += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x];
            }
        }
        const t2 = a; a = b; b = t2;
    }
    return a;
}

function smoothClosed(pts, iterations = 2) {
    for (let n = 0; n < iterations; n++) {
        const out = [];
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
            out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
        }
        pts = out;
    }
    return pts;
}

function traceContours(v0, w, h, iso) {
    const W = w + 2, H = h + 2;
    const v = new Uint8Array(W * H).fill(255);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[(y + 1) * W + x + 1] = v0[y * w + x];
    const key = (p) => Math.round(p[0] * 8192) * 65537 + Math.round(p[1] * 8192);
    const byKey = new Map(), allSegs = [];
    const seg = (a, b) => {
        if (a[0] === b[0] && a[1] === b[1]) return;
        const s = [a, b];
        allSegs.push(s);
        for (const p of [a, b]) {
            const k = key(p);
            if (!byKey.has(k)) byKey.set(k, []);
            byKey.get(k).push(s);
        }
    };
    const interp = (x0, y0, s0, x1, y1, s1) => {
        const t = (iso - s0) / (s1 - s0);
        return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    };
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
        const tl = v[y * W + x], tr = v[y * W + x + 1];
        const br = v[(y + 1) * W + x + 1], bl = v[(y + 1) * W + x];
        const idx = (tl < iso ? 8 : 0) | (tr < iso ? 4 : 0) | (br < iso ? 2 : 0) | (bl < iso ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const T = () => interp(x, y, tl, x + 1, y, tr);
        const R = () => interp(x + 1, y, tr, x + 1, y + 1, br);
        const B = () => interp(x, y + 1, bl, x + 1, y + 1, br);
        const L = () => interp(x, y, tl, x, y + 1, bl);
        const table = {
            1: [[B, L]], 2: [[R, B]], 3: [[L, R]], 4: [[T, R]],
            5: [[T, L], [R, B]], 6: [[T, B]], 7: [[T, L]],
            8: [[T, L]], 9: [[T, B]], 10: [[T, R], [B, L]],
            11: [[T, R]], 12: [[L, R]], 13: [[R, B]], 14: [[B, L]],
        };
        for (const [fa, fb] of table[idx]) seg(fa(), fb());
    }
    const used = new Set();
    const takeNext = (from) => {
        for (const s of byKey.get(key(from)) ?? []) {
            if (used.has(s)) continue;
            used.add(s);
            return key(s[0]) === key(from) ? s[1] : s[0];
        }
        return null;
    };
    const contours = [];
    for (const s0 of allSegs) {
        if (used.has(s0)) continue;
        used.add(s0);
        const loop = [s0[0], s0[1]];
        let guard = allSegs.length;
        while (guard-- > 0) {
            const next = takeNext(loop[loop.length - 1]);
            if (!next) break;
            const closed = key(next) === key(loop[0]);
            if (!closed) loop.push(next);
            if (closed) break;
        }
        if (loop.length >= 3) contours.push(loop.map(([x, y]) => [x - 1, y - 1]));
    }
    return contours;
}

/* ---- smiley (as in example/gen-smiley.mjs) ---- */
const W = 100, H = 100;
const px = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let val = 255;
    for (const [cx, cy, r] of [[35, 38, 7], [65, 38, 7]]) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) val = 0;
    }
    const d = Math.hypot(x - 50, y - 50), ang = Math.atan2(y - 50, x - 50);
    if (d >= 25 && d <= 31 && ang >= Math.PI / 4 && ang <= (3 * Math.PI) / 4) val = 0;
    px[y * W + x] = val;
}

/* ---- pipeline: dilate 1 → blur 1 → 50% isoline → SVG ---- */
let g = dilateDark(px, W, H, 1);
g = boxBlur(g, W, H, 1);
const contours = traceContours(g, W, H, 127.5);
const sizeX = 60, sizeY = 60;
const subpaths = contours.map((pts) =>
    smoothClosed(pts, 2).map(([x, y]) =>
        `${(x * sizeX / W).toFixed(3)} ${(y * sizeY / H).toFixed(3)}`));
const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${sizeX}mm" height="${sizeY}mm" viewBox="0 0 ${sizeX} ${sizeY}">
  <path fill="black" fill-rule="evenodd" d="${
    subpaths.map((p) => `M ${p[0]} L ${p.slice(1).join(" L ")} Z`).join(" ")}"/>
</svg>`;
console.log(`contour: ${contours.length} shapes, ` +
    `${subpaths.reduce((n, p) => n + p.length, 0)} points (after Chaikin×2)`);

/* ---- render via openscad ---- */
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
const instance = await OpenSCAD({
    noInitialRun: true, locateFile: (p) => `http://127.0.0.1:8123/${p}`,
    print: () => {}, printErr: () => {},
});
instance.FS.mkdir("/locale");
instance.FS.writeFile("/contour.svg", svg);
instance.FS.writeFile("/in.scad", `
size_x = 60; size_y = 60; relief_h = 5; base_h = 2;
union() {
    cube([size_x, size_y, base_h]);
    translate([0, 0, base_h])
        linear_extrude(height = relief_h)
            import("contour.svg", center = false);
}`);
const t0 = performance.now();
instance.callMain(["/in.scad", "-o", "/o.stl"]);
const stl = new TextDecoder().decode(instance.FS.readFile("/o.stl"));

// wall verticality: vertices only at z = 0, 2, 7
const levels = new Map();
let between = 0;
for (const m of stl.matchAll(/vertex (\S+) (\S+) (\S+)/g)) {
    const z = +m[3];
    const lvl = Math.abs(z) < 1e-6 ? "0" : Math.abs(z - 2) < 1e-6 ? "2" : Math.abs(z - 7) < 1e-6 ? "7" : null;
    if (lvl) levels.set(lvl, (levels.get(lvl) ?? 0) + 1);
    else between++;
}
console.log(`STL ${stl.length} bytes in ${Math.round(performance.now() - t0)} ms | vertices by level:`,
    [...levels].map(([l, n]) => `z=${l}: ${n}`).join(", "), "| intermediate heights:", between);
server.close();
