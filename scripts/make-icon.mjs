/**
 * Builds assets/logo.svg, build/icon.ico, build/icon.png and assets/icon.png
 * from one description of the mark.
 *
 * The shapes live here rather than in the SVG so that the vector source and
 * the raster files cannot drift apart: both are produced from the same table
 * by the same run.  Rasterising is done here too, by supersampling, because
 * there is no SVG rasteriser on this machine that can be relied on — the one
 * inside Electron needs a window, and a window is not something a build
 * should require.
 *
 * The generated files are committed: packaging runs on a CI machine with no
 * reason to have any of this set up, and an installer that quietly falls back
 * to the Electron default icon is worse than a binary in git.
 */
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ---------------------------------------------------------------- the mark */

/**
 * A page with a folded corner on a tile.
 *
 * The tile runs the app's own accent, #5aa8ff to #0b62d6, so the icon and
 * the UI agree about what colour this program is.  The page is what the
 * program is about, and it is deliberately the only other shape: at 16 px a
 * mark with more than one idea in it turns to mud.
 */
const TILE = { from: [0x5a, 0xa8, 0xff], to: [0x0b, 0x62, 0xd6], r: 112 }
const PAGE = '#f6fafe'
const FOLD = '#b7d1f3'
const TITLE = '#0b62d6'
const BODY = '#9dc2f4'

/** [x0, y0, x1, y1, cornerRadius] in the 512 viewBox. */
const LINES = [
  [156, 236, 300, 262, 13, TITLE],
  [156, 292, 352, 312, 10, BODY],
  [156, 340, 326, 360, 10, BODY]
]

/** The page, with the top-right corner folded down. */
const PAGE_PATH = [
  [138, 104],
  [296, 104],
  [392, 200],
  [392, 390],
  [374, 408],
  [138, 408],
  [120, 390],
  [120, 122]
]
const FOLD_PATH = [
  [296, 104],
  [392, 200],
  [296, 200]
]

/* -------------------------------------------------------------- rasterising */

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16)
]

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

const inPolygon = (pts, x, y) => {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Four samples per pixel each way, then an exact area average down.  For an
 * integer factor that is the correct filter, not an approximation of one, so
 * the small sizes come out clean without a resampling library.
 */
const SS = 4

function raster(n) {
  const r = n * SS
  const big = new Float64Array(r * r * 4)
  const tile = TILE
  for (let py = 0; py < r; py++) {
    const y = ((py + 0.5) / r) * 512
    for (let px = 0; px < r; px++) {
      const x = ((px + 0.5) / r) * 512
      const o = (py * r + px) * 4
      if (!inRoundRect(x, y, 0, 0, 512, 512, tile.r)) continue
      const t = Math.min(1, (x + y) / 1024)
      let c = [
        tile.from[0] + (tile.to[0] - tile.from[0]) * t,
        tile.from[1] + (tile.to[1] - tile.from[1]) * t,
        tile.from[2] + (tile.to[2] - tile.from[2]) * t
      ]
      if (inPolygon(PAGE_PATH, x, y)) c = hex(PAGE)
      if (inPolygon(FOLD_PATH, x, y)) c = hex(FOLD)
      for (const [x0, y0, x1, y1, rr, col] of LINES) {
        if (inRoundRect(x, y, x0, y0, x1, y1, rr)) c = hex(col)
      }
      big[o] = c[0]
      big[o + 1] = c[1]
      big[o + 2] = c[2]
      big[o + 3] = 255
    }
  }
  const out = new Uint8ClampedArray(n * n * 4)
  const per = SS * SS
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sr = 0
      let sg = 0
      let sb = 0
      let sa = 0
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const o = ((y * SS + dy) * r + x * SS + dx) * 4
          const a = big[o + 3]
          sr += big[o] * a
          sg += big[o + 1] * a
          sb += big[o + 2] * a
          sa += a
        }
      }
      const o = (y * n + x) * 4
      out[o + 3] = Math.round(sa / per)
      if (sa > 0) {
        out[o] = Math.round(sr / sa)
        out[o + 1] = Math.round(sg / sa)
        out[o + 2] = Math.round(sb / sa)
      }
    }
  }
  return out
}

/* ------------------------------------------------------------- png and ico */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const encodePng = (n, rgba) => {
  const stride = n * 4
  const raw = Buffer.alloc((stride + 1) * n)
  for (let y = 0; y < n; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(n, 0)
  ihdr.writeUInt32BE(n, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * An ICO is a directory of images, and PNG entries have been valid in one
 * since Vista, which is the only reason this does not need a BMP writer.  A
 * width of 256 is stored as 0, because the field is a single byte.
 */
const buildIco = (entries) => {
  const dir = Buffer.alloc(6 + 16 * entries.length)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(entries.length, 4)
  let off = dir.length
  entries.forEach((e, i) => {
    const at = 6 + 16 * i
    dir.writeUInt8(e.n >= 256 ? 0 : e.n, at)
    dir.writeUInt8(e.n >= 256 ? 0 : e.n, at + 1)
    dir.writeUInt16LE(1, at + 4)
    dir.writeUInt16LE(32, at + 6)
    dir.writeUInt32LE(e.buf.length, at + 8)
    dir.writeUInt32LE(off, at + 12)
    off += e.buf.length
  })
  return Buffer.concat([dir, ...entries.map((e) => e.buf)])
}

/* ------------------------------------------------------------------- output */

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Mendeley NG">
  <!-- generated by scripts/make-icon.mjs; edit the shapes there, not here -->
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5aa8ff" />
      <stop offset="1" stop-color="#0b62d6" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${TILE.r}" fill="url(#tile)" />
  <path d="M138 104H296L392 200V390Q392 408 374 408H138Q120 408 120 390V122Q120 104 138 104Z" fill="${PAGE}" />
  <path d="M296 104L392 200H296Z" fill="${FOLD}" />
${LINES.map(
  ([x0, y0, x1, y1, r, col]) =>
    `  <rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="${r}" fill="${col}" />`
).join('\n')}
</svg>
`

/** Windows wants 16 to 256; 512 goes in the standalone png instead. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

fs.mkdirSync(path.join(root, 'build'), { recursive: true })
fs.writeFileSync(path.join(root, 'assets', 'logo.svg'), svg)

const pngs = new Map()
for (const n of [...ICO_SIZES, 512]) {
  pngs.set(n, encodePng(n, raster(n)))
  console.log('rendered', n + 'px', pngs.get(n).length, 'bytes')
}

fs.writeFileSync(path.join(root, 'build', 'icon.png'), pngs.get(512))
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), pngs.get(256))
fs.writeFileSync(
  path.join(root, 'build', 'icon.ico'),
  buildIco(ICO_SIZES.map((n) => ({ n, buf: pngs.get(n) })))
)
console.log('wrote assets/logo.svg, build/icon.ico, build/icon.png, assets/icon.png')
