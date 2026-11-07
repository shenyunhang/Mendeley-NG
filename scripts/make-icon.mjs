/**
 * Builds assets/logo.svg, build/icon.ico, build/icon.png and assets/icon.png
 * from one description of the mark.
 *
 * The mark is Mendeley's own: the graphic half of the logo shipped with
 * Mendeley Desktop 1.19.8 (MendeleyLogo.png), vectorised once with sub-pixel
 * marching squares into two polygon rings — the outline and the round hole in
 * the middle. The wordmark is deliberately not part of it; at 16 px a word is
 * unreadable and the mark is what gets recognised.
 *
 * What changed is the colour, and only the colour. The official logo is solid
 * black (or Mendeley red in the brand kit); this build fills the same shape
 * with NG's violet-to-cyan horizontal gradient, so the reader can tell at a
 * glance that this is the local-first client and not the old desktop app.
 *
 * The shapes live here rather than in the SVG so that the vector source and
 * the raster files cannot drift apart: both are produced from RINGS by the
 * same run. Rasterising is done here too, by supersampling, because there is
 * no SVG rasteriser on this machine that can be relied on — the one inside
 * Electron needs a window, and a window is not something a build should
 * require.
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
 * Two closed rings in a 512 canvas, traced from the official bitmap at a
 * 0.5 alpha contour and simplified to 0.7 px. The first is the outline
 * (three bottom discs, two upper lobes and the two open side arches); the
 * second is the round hole in the centre. Even-odd filling over both rings
 * is what turns the hole back into background.
 *
 * Normalised from the 210x116 crop of the official PNG: scaled by 480/210,
 * left at x=16 and centred vertically. Keep this table as the single source
 * of truth; every file below is derived from it.
 */
const RINGS = [
  [[141.7,130.3],[128,134.8],[114.3,143],[102.1,155.4],[93.3,171.4],[89.1,203.4],[96.8,242.3],[97.5,260.6],[96.2,272],[91.4,283.1],[77.7,292.8],[57.1,294.1],[43.4,298.7],[28.2,310.9],[22.4,320],[19.8,333.7],[22,354.3],[28.8,368],[38.9,377.4],[54.9,384.6],[70.9,385.1],[82.3,382.2],[96,372.1],[103.8,361.1],[108.2,345.1],[106,326.9],[99.6,308.6],[101.8,290.3],[107.4,282.1],[118.9,273.1],[148.6,264.4],[164.6,264.4],[185.1,268.7],[198.9,275.8],[206.6,283.4],[211.2,292.6],[211.8,304],[203,329.1],[203,349.7],[212.1,368],[233.1,382.6],[246.9,385.1],[269.7,382.6],[290.7,368],[297.6,356.6],[300.6,345.1],[299.9,329.1],[291.6,308.6],[291,297.1],[293.6,288],[300.4,278.9],[310.9,271.5],[338.3,264.4],[354.3,264.4],[374.9,268.8],[388.6,275.8],[398.6,285.7],[402.7,294.9],[403.4,306.3],[394.7,336],[395,347.4],[401.5,365.7],[413.7,378.2],[427.4,384.5],[445.7,385.1],[459.4,380.3],[474,368],[480.5,354.3],[482.3,342.9],[480.8,324.6],[474.4,310.9],[464,300.8],[454.9,296.3],[420.6,291.3],[408.7,278.9],[405.3,253.7],[413.7,203.4],[412.6,182.9],[405.2,162.3],[388.6,143],[372.6,133.9],[358.9,129.7],[338.3,129.1],[324.6,132.1],[301.7,145.8],[269.7,181.5],[251.4,188.2],[233.1,181.3],[201.1,145.8],[187.4,136.3],[169.1,129.7],[141.7,130.3]],
  [[244.6,203.4],[265.1,204.8],[278.9,212.1],[291,226.3],[295.9,240],[295.5,258.3],[286.3,276.6],[272,288.5],[253.7,293.3],[237.7,291],[224,283.9],[211.8,269.7],[206.9,256],[207.2,237.7],[214.6,221.7],[228.6,209.1],[244.6,203.4]]
]

/** Two stops, one cool family. The official mark is a single flat colour;
 *  the gradient is the entire change, and it runs across the shape rather
 *  than along it, so all three discs read as parts of one mark. */
const RAMP = [
  [0.0, [0x6d, 0x3b, 0xf5]],
  [1.0, [0x1f, 0xd1, 0xe5]]
]

const rampAt = (x) => {
  const t = Math.min(1, Math.max(0, x))
  const [t0, c0] = RAMP[0]
  const [t1, c1] = RAMP[1]
  const f = (t - t0) / (t1 - t0)
  return [0, 1, 2].map((j) => c0[j] + (c1[j] - c0[j]) * f)
}

const toHex = (c) =>
  '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/* -------------------------------------------------------------- rasterising */

/**
 * Horizontal scanlines: for one sample row, the x positions where any ring
 * crosses it. A point is inside when an odd number of crossings lie to its
 * left, which is even-odd filling and handles the central hole for free.
 * This is also what makes the supersampling affordable — a sample asks one
 * short sorted list instead of walking all 109 edges.
 */
function scanlines(r) {
  const lines = []
  for (let sy = 0; sy < r; sy++) {
    const y = ((sy + 0.5) / r) * 512
    const xs = []
    for (const ring of RINGS) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (yi > y !== yj > y) xs.push(xi + ((xj - xi) * (y - yi)) / (yj - yi))
      }
    }
    xs.sort((a, b) => a - b)
    lines.push(xs)
  }
  return lines
}

const inside = (x, xs) => {
  let n = 0
  for (const cx of xs) {
    if (cx > x) break
    n++
  }
  return n % 2 === 1
}

/** Four samples per pixel each way, then an exact area average down. */
const SS = 4
const lineCache = new Map()

function raster(n) {
  const r = n * SS
  if (!lineCache.has(r)) lineCache.set(r, scanlines(r))
  const lines = lineCache.get(r)
  const out = new Uint8ClampedArray(n * n * 4)
  const per = SS * SS
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      let sr = 0
      let sg = 0
      let sb = 0
      let sa = 0
      for (let dy = 0; dy < SS; dy++) {
        const xs = lines[py * SS + dy]
        for (let dx = 0; dx < SS; dx++) {
          const x = ((px * SS + dx + 0.5) / r) * 512
          if (!inside(x, xs)) continue
          const c = rampAt(x / 512)
          sr += c[0]
          sg += c[1]
          sb += c[2]
          sa++
        }
      }
      const o = (py * n + px) * 4
      out[o + 3] = Math.round((255 * sa) / per)
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
 * since Vista, which is the only reason this does not need a BMP writer.
 * A width of 256 is stored as 0, because the field is a single byte.
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

const ringPath = (ring) =>
  'M' + ring.map(([x, y]) => x.toFixed(1) + ' ' + y.toFixed(1)).join('L') + 'Z'
const D = RINGS.map(ringPath).join('')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Mendeley NG">
  <!-- generated by scripts/make-icon.mjs; edit RINGS there, not here -->
  <defs><linearGradient id="ng" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="512" y2="0"><stop offset="0" stop-color="${toHex(RAMP[0][1])}"/><stop offset="1" stop-color="${toHex(RAMP[1][1])}"/></linearGradient></defs>
  <path d="${D}" fill="url(#ng)" fill-rule="evenodd"/>
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
