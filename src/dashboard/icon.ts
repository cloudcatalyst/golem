/**
 * R12.5 — the companion app's home-screen icon, generated with no dependency.
 *
 * An installable web app needs real raster icons: Android reads them from the
 * web manifest, and iOS ignores the manifest entirely and takes
 * `<link rel="apple-touch-icon">`, which in practice must be a PNG. Golem ships
 * five runtime dependencies and no build step, so neither a bundled binary asset
 * nor an image library is available — but `node:zlib` is built in, and a PNG is
 * a handful of length-prefixed, CRC-checked chunks around a zlib stream. That is
 * the whole file.
 *
 * The mark is Golem's hexagon (⬢), supersampled 3x3 so the diagonals do not
 * stair-step at 192px. Deterministic: same size in, same bytes out, so the
 * ETag/caching story is trivial and tests can assert on the header.
 */

import { deflateSync } from "node:zlib";

/** Icon sizes the manifest advertises. 180 is the iOS `apple-touch-icon` size. */
export const ICON_SIZES = [180, 192, 512] as const;

export type IconSize = (typeof ICON_SIZES)[number];

/** Dark slate ground — legible against both light and dark home screens. */
const BACKGROUND: RGB = [22, 22, 20];
/** The same accent green the dashboard uses for `--accent` in dark mode. */
const MARK: RGB = [127, 201, 162];

type RGB = readonly [number, number, number];

/** Samples per axis inside each pixel; 3 => 9 samples, enough to kill the jaggies. */
const SUPERSAMPLE = 3;

/**
 * Is `(x, y)` inside the regular hexagon centred on the canvas?
 *
 * Flat-top hexagon, expressed as the intersection of three slabs — the standard
 * hex half-plane test. `r` is the circumradius.
 */
function insideHexagon(x: number, y: number, cx: number, cy: number, r: number): boolean {
  const dx = Math.abs(x - cx) / r;
  const dy = Math.abs(y - cy) / r;
  // Pointy-top hexagon: |y| <= sqrt(3)/2 and sqrt(3)*|x| + |y| <= sqrt(3).
  const SQRT3 = Math.sqrt(3);
  if (dy > SQRT3 / 2) return false;
  return SQRT3 * dx + dy <= SQRT3;
}

/** Raw RGB raster for one icon, with a filter byte 0 in front of every scanline. */
function raster(size: number): Buffer {
  const rowBytes = size * 3 + 1;
  const out = Buffer.alloc(rowBytes * size);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.34;
  const step = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * rowBytes;
    out[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          if (insideHexagon(px, py, cx, cy, r)) hits += 1;
        }
      }
      const t = hits / samples;
      const at = rowStart + 1 + x * 3;
      for (let c = 0; c < 3; c += 1) {
        const bg = BACKGROUND[c] as number;
        const fg = MARK[c] as number;
        out[at + c] = Math.round(bg + (fg - bg) * t);
      }
    }
  }
  return out;
}

/** CRC-32 (the PNG polynomial), table built once on first use. */
let crcTable: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over (type + data). */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const cache = new Map<number, Buffer>();

/**
 * The icon as PNG bytes. Memoised per size — the generator is pure, and a phone
 * re-requesting the icon on every install should not re-rasterise 512x512.
 */
export function iconPng(size: IconSize): Buffer {
  const hit = cache.get(size);
  if (hit !== undefined) return hit;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  const png = Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raster(size), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  cache.set(size, png);
  return png;
}

/** `/icon-<size>.png` -> the size, or null when the path is not an icon route. */
export function iconSizeForPath(pathname: string): IconSize | null {
  const match = /^\/icon-(\d+)\.png$/.exec(pathname);
  if (match === null) return null;
  const size = Number(match[1]);
  return (ICON_SIZES as readonly number[]).includes(size) ? (size as IconSize) : null;
}
