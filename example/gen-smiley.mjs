// Generates example/www/assets/smiley.png — the height-map image used by the
// surface() example in the viewer (docs examples 3a/3b). Pure node: a minimal
// grayscale PNG encoder on top of zlib, no dependencies. Run it through
// docker only:
//
//   docker run --rm \
//       -v "$PWD/example:/out" \
//       -v "$PWD/example/gen-smiley.mjs:/gen.mjs:ro" \
//       node:22-slim node /gen.mjs
import { deflateSync } from "zlib";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const W = 100;
const H = 100;

// 8-bit grayscale raster, white (255) = high, black (0) = low:
// a smiley face — two eyes and a smile arc.
const px = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        let v = 255;
        for (const [cx, cy, r] of [[35, 38, 7], [65, 38, 7]]) {
            if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) v = 0; // eyes
        }
        const dx = x - 50, dy = y - 50;
        const d = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx); // y grows down, so π/4..3π/4 is the bottom arc
        if (d >= 25 && d <= 31 && ang >= Math.PI / 4 && ang <= (3 * Math.PI) / 4) v = 0; // smile
        px[y * W + x] = v;
    }
}

function crc32(buf) {
    if (!crc32.table) {
        const table = crc32.table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c;
        }
    }
    let c = 0xffffffff;
    for (const b of buf) c = crc32.table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 0; // color type: grayscale
// compression / filter / interlace = 0 (already zero)

// scanlines, each prefixed with filter byte 0 (None)
const raw = Buffer.alloc(H * (1 + W));
for (let y = 0; y < H; y++) {
    Buffer.from(px.buffer, y * W, W).copy(raw, y * (1 + W) + 1);
}

const png = Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
]);

// Output path comes from argv so the same script works from any cwd/mount.
const out = process.argv[2] ?? "www/assets/smiley.png";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out}: ${png.length} bytes`);
