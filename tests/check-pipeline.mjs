// Numerical check of the heightmap.html processing pipeline (function copies):
// 1) a thin line must not disappear under smoothing (thickening),
// 2) a soft edge must produce intermediate values at the boundary.
const W = 16, H = 16;

function dilateDark(src, w, h, r) {
    if (r <= 0) return src;
    const tmp = new Uint8Array(src.length);
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let m = 255;
            for (let d = -r; d <= r; d++) {
                const xx = Math.min(w - 1, Math.max(0, x + d));
                const v = src[y * w + xx];
                if (v < m) m = v;
            }
            tmp[y * w + x] = m;
        }
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let m = 255;
            for (let d = -r; d <= r; d++) {
                const yy = Math.min(h - 1, Math.max(0, y + d));
                const v = tmp[yy * w + x];
                if (v < m) m = v;
            }
            dst[y * w + x] = m;
        }
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
                sum += src[y * w + Math.min(w - 1, x + r + 1)] -
                       src[y * w + Math.max(0, x - r)];
            }
        }
        const t = a; a = b; b = t === src ? new Uint8Array(src.length) : t;
        for (let x = 0; x < w; x++) {
            let sum = a[x] * (r + 1);
            for (let d = 1; d <= r; d++) sum += a[Math.min(h - 1, d) * w + x];
            for (let y = 0; y < h; y++) {
                b[y * w + x] = Math.round(sum / win);
                sum += a[Math.min(h - 1, y + r + 1) * w + x] -
                       a[Math.max(0, y - r) * w + x];
            }
        }
        const t2 = a; a = b; b = t2;
    }
    return a;
}

// a thin 1px vertical line on white (x=8)
const src = new Uint8Array(W * H).fill(255);
for (let y = 0; y < H; y++) src[y * W + 8] = 0;

const thr = 50 * 2.55;
function render(g, binary, soft) {
    const band = binary ? (soft ? 51 : 0) : 255;
    const out = new Uint8Array(g.length);
    for (let i = 0; i < g.length; i++) {
        let v;
        if (band <= 0) v = g[i] < thr ? 0 : 255;
        else {
            const t = (g[i] - (thr - band)) / (2 * band);
            v = Math.round(255 * Math.min(1, Math.max(0, t)));
        }
        out[i] = v;
    }
    return out;
}

const row = (arr) => [...arr.slice(7 * W, 7 * W + W)].map((v) => String(v).padStart(3)).join(" ");

// 1) no thickening: does a 1px blur "eat" the line?
let g = boxBlur(src, W, H, 1);
let out = render(g, true, true);
console.log("no thickening, blur 1, soft edge:", row(out));

// 2) with 1px thickening + 1px blur + soft edge
g = boxBlur(dilateDark(src, W, H, 1), W, H, 1);
out = render(g, true, true);
console.log("thicken 1,     blur 1, soft edge:", row(out));

// 3) same, but a hard threshold (for comparison — a step)
out = render(g, true, false);
console.log("thicken 1,     blur 1, hard edge:", row(out));
