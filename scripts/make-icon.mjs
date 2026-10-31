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
 * One strip of paper, folded twice, into an N.
 *
 * The mark is the program's initial and the program's subject at the same
 * time: the strip is continuous, so the N is not a letter laid on top of a
 * document, it is a document that happens to be folded that way.  You read
 * the letter first and the paper second, which is the whole point of it.
 *
 * Nothing else shares the tile.  At 16 px a mark carrying two ideas turns
 * to mud, and a page, a fold and three lines of text — which is what was
 * here before — is four.
 *
 * The one exception is the strip's own underside: the same strip shifted
 * down and right and washed dark, which is there to give the paper
 * thickness, not to say anything of its own.
 *
 * The tile runs from the light-theme accent to the dark-theme accent, so
 * the icon and the UI agree about what colour this program is.
 */
const TILE = { from: [0x4a, 0x9e, 0xff], to: [0x0b, 0x62, 0xd6], r: 112 }
const SHEET = '#f5faff'
/** The middle leg, turned away from the light, a shade off the two uprights. */
const TURNED = '#d9e8fb'
const UNDER = { dx: 16, dy: 20, ink: [0x04, 0x26, 0x59], mix: 0.5 }

/** Centreline of the strip: up the left, down the diagonal, up the right. */
const FOLD = [
  [168, 384],
  [168, 128],
  [344, 384],
  [344, 128]
]
/** Half the width of the strip. */
const HALF = 36

/* -------------------------------------------------------------- rasterising */

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16)
]

const toHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')

const shift = (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy])

const unit = ([x, y]) => {
  const l = Math.hypot(x, y)
  return [x / l, y / l]
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]

/**
 * Where a strip creases when it is folded at `at`: the crease runs across the
 * strip along d_out - d_in, and `n` is the normal pointing at the leg after
 * the fold.  Take a square corner as the check — a strip travelling up that
 * leaves travelling right creases along the diagonal, which is what a ribbon
 * bent round a corner actually does.
 */
const crease = (before, at, after) => {
  const din = unit(sub(at, before))
  const dout = unit(sub(after, at))
  const along = unit([dout[0] - din[0], dout[1] - din[1]])
  return { n: [along[1], -along[0]], at }
}

/** Keep the half of `poly` that a crease leaves on the far side of. */
const clipHalf = (poly, { n, at }) => {
  const side = (p) => (p[0] - at[0]) * n[0] + (p[1] - at[1]) * n[1]
  const out = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const da = side(a)
    const db = side(b)
    if (da >= 0) out.push(a)
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db)
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}

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
 * Distance from a point to a segment, and so: is the point within h of the
 * polyline.  That is exactly what an SVG stroke of width 2h with round caps
 * and round joins covers, which is why the vector and the rasters agree
 * without either of them knowing about the other's idea of a stroke.
 */
const distToSegment = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = l2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / l2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const qx = ax + t * dx - x
  const qy = ay + t * dy - y
  return Math.sqrt(qx * qx + qy * qy)
}

const inStroke = (pts, x, y, h) => {
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= h) return true
  }
  return false
}

/**
 * Four samples per pixel each way, then an exact area average down.  For an
 * integer factor that is the correct filter, not an approximation of one, so
 * the small sizes come out clean without a resampling library.
 */
const SS = 4

const FOLD_UNDER = shift(FOLD, UNDER.dx, UNDER.dy)

/**
 * The middle leg on its own.  Stroked as a pill it reaches exactly to the two
 * creases and no further — a pill of the same width is a subset of the strip
 * it was cut from — so recolouring it shades the turned part of the paper
 * without touching the two uprights.
 */
const FOLD_MIDDLE = [FOLD[1], FOLD[2]]

/**
 * The two creases as a polygon: the whole canvas cut down to the wedge between
 * them, which is the part of the strip that lies past both folds.  The
 * rasters test against it and the SVG clips to it, so the shade stops on a
 * straight line across the strip rather than on the round cap's curve.
 */
const TURN = clipHalf(
  clipHalf(
    [
      [-64, -64],
      [576, -64],
      [576, 576],
      [-64, 576]
    ],
    crease(FOLD[0], FOLD[1], FOLD[2])
  ),
  crease(FOLD[1], FOLD[2], FOLD[3])
)

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
      if (inStroke(FOLD_UNDER, x, y, HALF)) {
        const m = UNDER.mix
        c = [
          c[0] * (1 - m) + UNDER.ink[0] * m,
          c[1] * (1 - m) + UNDER.ink[1] * m,
          c[2] * (1 - m) + UNDER.ink[2] * m
        ]
      }
      if (inStroke(FOLD, x, y, HALF)) c = hex(SHEET)
      if (inStroke(FOLD_MIDDLE, x, y, HALF) && inPolygon(TURN, x, y)) c = hex(TURNED)
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

const pathD = (pts) => pts.map(([x, y], i) => (i ? 'L' : 'M') + x + ' ' + y).join('')

/** Round caps and round joins, so the path covers what inStroke() covers. */
const stroke = (pts, col, opacity) =>
  `<path d="${pathD(pts)}" fill="none" stroke="${col}"` +
  (opacity === undefined ? '' : ` stroke-opacity="${opacity}"`) +
  ` stroke-width="${HALF * 2}" stroke-linecap="round" stroke-linejoin="round" />`

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Mendeley NG">
  <!-- generated by scripts/make-icon.mjs; edit the shapes there, not here -->
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${toHex(TILE.from)}" />
      <stop offset="1" stop-color="${toHex(TILE.to)}" />
    </linearGradient>
  </defs>
  <clipPath id="turn">
    <polygon points="${TURN.map(([x, y]) => x.toFixed(2) + ',' + y.toFixed(2)).join(' ')}" />
  </clipPath>
  <rect width="512" height="512" rx="${TILE.r}" fill="url(#tile)" />
  ${stroke(FOLD_UNDER, toHex(UNDER.ink), UNDER.mix)}
  ${stroke(FOLD, SHEET)}
  <g clip-path="url(#turn)">${stroke(FOLD_MIDDLE, TURNED)}</g>
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
