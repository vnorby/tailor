// Rasterize the Tailor mark (tape-yellow T on charcoal, rounded square) to PNGs without image deps.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function png(size) {
  const S = 4; // supersample
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const u = ((x + (sx + 0.5) / S) / size) * 128, v = ((y + (sy + 0.5) / S) / size) * 128;
        const R = 28, inX = Math.max(R - u, 0, u - (128 - R)), inY = Math.max(R - v, 0, v - (128 - R));
        if (inX * inX + inY * inY > R * R) continue;
        const T = (u >= 30 && u <= 98 && v >= 36 && v <= 52) || (u >= 56 && u <= 72 && v >= 36 && v <= 100);
        const [cr, cg, cb] = T ? [0xe8, 0xc5, 0x47] : [0x14, 0x14, 0x16];
        r += cr; g += cg; b += cb; a += 255;
      }
      const n = S * S, o = y * (size * 4 + 1) + 1 + x * 4, cov = a / n / 255 || 1;
      raw[o] = r / n / cov; raw[o + 1] = g / n / cov; raw[o + 2] = b / n / cov; raw[o + 3] = a / n;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
mkdirSync("public/icons", { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icons/${s}.png`, png(s));
console.log("icons written");
