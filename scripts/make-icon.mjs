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
 * A sheet of paper rolled up, with its free end still sticking out.
 *
 * The two marks before this were both a coloured rounded square with a white
 * shape on it, which is what nearly every program draws, and the second was
 * also a letter — which Zotero had already done.  This one is only itself:
 * there is no tile, so what is recognised at 16 px is the outline of the
 * thing rather than a container with something sitting in it.
 *
 * It is a sheet being rolled rather than a document, a folder or a book,
 * because the coil is what paper does and nothing else does, and because the
 * free end is half of the meaning: without it the roll is a spring.
 *
 * The colour runs *along* the sheet rather than across the canvas, so what
 * you see is the winding — violet in the tight core, the program's own blue
 * through the middle of the roll, teal as it opens out, amber on the end that
 * is still out in the light, and red on the last of it.  A gradient across
 * the canvas would light the coil like a rendering of a solid, and lose the
 * sense of one long thing wound up.  Red goes at the end rather than in the
 * core because the end is what the eye is already on, and because a warm end
 * on a cool coil is the one place a hot colour does not read as a warning.
 */
const ROLL = {
  /**
   * How many times the sheet goes round.  Enough to read as a coil and not
   * as a hook: the gap left between two turns is (rOut - rIn) / turns less
   * the thickness of the sheet, and past about two turns that gap is gone by
   * 32 px, where the coil would close up into a disc.
   */
  turns: 1.6,
  rIn: 64,
  rOut: 184,
  /** Half the thickness of the sheet. */
  half: 25,
  /** How far the free end runs on past the roll. */
  tail: 138,
  /** How far the free end turns away from the roll as it runs on.  Left at
   *  zero it carries on along the tangent and hugs the outside of the coil,
   *  which is what made the first attempt look like a hook rather than like
   *  an end that has come loose. */
  spread: 1.2,
  /** Where the outer end sits, chosen so the free end leaves towards the
   *  upper right, the one corner that leaves room for it, and so the mark
   *  balances on the canvas. */
  at: Math.PI * 0.39
}

/**
 * The colours along the sheet, from the tight core to the free end.
 *
 * The last stretch is warm all the way and ends red.  The free end is only a
 * tenth of the sheet, so a red placed anywhere but on it would be a smear;
 * here the whole of the end that is out of the roll is red, and the amber
 * before it is what keeps it from looking like a warning light.  One warm end
 * against a cool coil is also what stops six colours reading as a rainbow.
 */
const RAMP = [
  [0.0, [0x7b, 0x3f, 0xf2]],
  [0.28, [0x3f, 0x8c, 0xf0]],
  [0.5, [0x16, 0xc8, 0xb8]],
  [0.66, [0xff, 0xb0, 0x2e]],
  [0.82, [0xfb, 0x5a, 0x1e]],
  [1.0, [0xe8, 0x24, 0x3c]]
]

/** Clear space kept around the mark on every side. */
const MARGIN = 16

const unit = ([x, y]) => {
  const l = Math.hypot(x, y)
  return [x / l, y / l]
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]

/**
 * The centreline: an Archimedean spiral out from the core, then the free end.
 *
 * The end leaves the roll along the tangent it already had — there is a crease
 * in the mark if it does not — and then turns away from the coil, gently at
 * first so that the join has no corner in it, and gently again at the last so
 * that the end is straight by the time it stops.  Left carrying on along the
 * tangent it would hug the outside of the coil, which is what made the first
 * attempt look like a hook rather than like an end that has come loose.
 */
function rollPath() {
  const T = ROLL.turns * Math.PI * 2
  const k = (ROLL.rOut - ROLL.rIn) / T
  const n = 140
  const pts = []
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * T
    const r = ROLL.rIn + k * th
    const a = ROLL.at + th
    pts.push([Math.cos(a) * r, Math.sin(a) * r])
  }
  const tip = pts[pts.length - 1]
  const dir = unit(sub(tip, pts[pts.length - 2]))
  const a0 = Math.atan2(dir[1], dir[0])
  const step = ROLL.tail / 24
  let x = tip[0]
  let y = tip[1]
  for (let i = 1; i <= 24; i++) {
    const u = i / 24
    const ang = a0 - ROLL.spread * u * u * (3 - 2 * u)
    x += Math.cos(ang) * step
    y += Math.sin(ang) * step
    pts.push([x, y])
  }
  return pts
}

/**
 * The first and the last stretch of the line, each as a single segment.
 *
 * A stroke bulges past its end by half the thickness less however long the
 * end segment is, so with segments as short as these are it would bulge by
 * nearly the whole thickness and the ends would come out round.  Both ends
 * of the line are very nearly straight over that distance -- the spiral
 * turns by a fifth of a radian in it, and the free end has stopped turning
 * by then -- so each end can be one segment, and one long enough that there
 * is nothing left to bulge by.  What is left of the bulge is what makes the
 * ends of the sheet read as cut.
 */
const squareEnds = (pts) => {
  const first = pts[0]
  const last = pts[pts.length - 1]
  const away = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
  let i = 1
  while (i < pts.length - 2 && away(first, pts[i]) < ROLL.half) i++
  let j = pts.length - 2
  while (j > i && away(last, pts[j]) < ROLL.half) j--
  return [first, ...pts.slice(i, j + 1), last]
}

/**
 * Scaled to leave `MARGIN` clear all round and centred on the ink, so the
 * numbers above can be changed without having to work out afresh where the
 * mark ends up.
 *
 * Centred halfway between the middle of the box and the middle of the ink.
 * The box alone puts the coil off to one side, with a bare corner opposite
 * the free end; the ink alone puts the free end hard against the edge and
 * leaves the same bare corner, larger, on the other side.  Halfway between
 * them keeps the mark as large as the box allows and still puts most of the
 * ink near the middle.  The ink is spread evenly along the sheet, so the
 * middle of the ink is the middle of the centreline taken by length.
 */
const CANVAS = (() => {
  const raw = squareEnds(rollPath())
  const len = []
  let total = 0
  for (let i = 1; i < raw.length; i++) {
    const l = Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1])
    len.push(l)
    total += l
  }
  let gx = 0
  let gy = 0
  for (let i = 0; i < raw.length; i++) {
    const w = ((i > 0 ? len[i - 1] : 0) + (i < len.length ? len[i] : 0)) / 2
    gx += raw[i][0] * w
    gy += raw[i][1] * w
  }
  gx /= total
  gy /= total
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of raw) {
    x0 = Math.min(x0, x - ROLL.half)
    y0 = Math.min(y0, y - ROLL.half)
    x1 = Math.max(x1, x + ROLL.half)
    y1 = Math.max(y1, y + ROLL.half)
  }
  gx = (gx + (x0 + x1) / 2) / 2
  gy = (gy + (y0 + y1) / 2) / 2
  const s = (256 - MARGIN) / Math.max(gx - x0, x1 - gx, gy - y0, y1 - gy)
  return {
    half: ROLL.half * s,
    pts: raw.map(([x, y]) => [256 + (x - gx) * s, 256 + (y - gy) * s])
  }
})()

const HALF = CANVAS.half
const PATH = CANVAS.pts

/** The sheet as segments, each carrying how far along the sheet it starts. */
const SEG = []
let TOTAL = 0
for (let i = 1; i < PATH.length; i++) {
  const [ax, ay] = PATH[i - 1]
  const [bx, by] = PATH[i]
  const len = Math.hypot(bx - ax, by - ay)
  SEG.push({ ax, ay, bx, by, len, at: TOTAL })
  TOTAL += len
}

/**
 * Which segments can reach into each cell of a grid laid over the canvas.
 *
 * The sheet is 250 segments long and asking about every one of them for
 * every sample of every pixel is a hundred times the work the mark used to
 * cost, back when it was three straight lines.  A segment can only matter to
 * a sample if it comes within half the thickness of that sample's cell, so
 * the candidates are worked out once per cell and the loop below looks at
 * nothing else.
 */
const GRID = 24
const CELLS = (() => {
  const cells = Array.from({ length: GRID * GRID }, () => [])
  const w = 512 / GRID
  for (let s = 0; s < SEG.length; s++) {
    const g = SEG[s]
    const cx0 = Math.max(0, Math.floor((Math.min(g.ax, g.bx) - HALF) / w))
    const cx1 = Math.min(GRID - 1, Math.floor((Math.max(g.ax, g.bx) + HALF) / w))
    const cy0 = Math.max(0, Math.floor((Math.min(g.ay, g.by) - HALF) / w))
    const cy1 = Math.min(GRID - 1, Math.floor((Math.max(g.ay, g.by) + HALF) / w))
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) cells[cy * GRID + cx].push(s)
    }
  }
  return cells
})()

/**
 * Whether a point is on the sheet, and how far along the sheet it is.
 *
 * The sheet is everything within half the thickness of the centreline, which
 * is what an SVG stroke of that width covers with round caps and joins, and
 * is why the vector and the ten rasters agree without either of them knowing
 * how the other draws a stroke.  Past the first and the last segment there is
 * nothing, which is the square end the two pieces at the ends are drawn with.
 */
function nearest(x, y) {
  const cx = Math.min(GRID - 1, Math.max(0, Math.floor((x * GRID) / 512)))
  const cy = Math.min(GRID - 1, Math.max(0, Math.floor((y * GRID) / 512)))
  let best = Infinity
  let along = 0
  for (const s of CELLS[cy * GRID + cx]) {
    const g = SEG[s]
    const dx = g.bx - g.ax
    const dy = g.by - g.ay
    const l2 = dx * dx + dy * dy
    let t = l2 === 0 ? 0 : ((x - g.ax) * dx + (y - g.ay) * dy) / l2
    if (s === 0 && t < 0) continue
    if (s === SEG.length - 1 && t > 1) continue
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const qx = g.ax + t * dx - x
    const qy = g.ay + t * dy - y
    const d = qx * qx + qy * qy
    if (d < best) {
      best = d
      along = g.at + g.len * t
    }
  }
  return { d: Math.sqrt(best), t: along / TOTAL }
}

const rampAt = (t) => {
  let i = 1
  while (i < RAMP.length - 1 && t > RAMP[i][0]) i++
  const [t0, c0] = RAMP[i - 1]
  const [t1, c1] = RAMP[i]
  const f = t1 === t0 ? 0 : Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))
  return [0, 1, 2].map((j) => c0[j] + (c1[j] - c0[j]) * f)
}

const toHex = (c) =>
  '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/**
 * Four samples per pixel each way, then an exact area average down.  For an
 * integer factor that is the correct filter, not an approximation of one, so
 * the small sizes come out clean without a resampling library.
 */
const SS = 4

function raster(n) {
  const r = n * SS
  const big = new Float64Array(r * r * 4)
  for (let py = 0; py < r; py++) {
    const y = ((py + 0.5) / r) * 512
    for (let px = 0; px < r; px++) {
      const x = ((px + 0.5) / r) * 512
      const o = (py * r + px) * 4
      const near = nearest(x, y)
      if (near.d > HALF) continue
      const c = rampAt(near.t)
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

const pathD = (pts) =>
  pts.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join('')

/** Round joins, so a piece covers what nearest() says it covers. */
const stroke = (pts, col, cap) =>
  `<path d="${pathD(pts)}" stroke="${col}"` +
  (cap ? ` stroke-linecap="${cap}"` : '') +
  ` />`

/**
 * The sheet cut into short pieces, each with its own colour.
 *
 * There is no way to put a gradient *along* a stroke in SVG — a paint server
 * is a function of the canvas, not of the distance travelled — so the ramp is
 * applied by hand, one stroked sub-path per piece.  The pieces are drawn with
 * round caps, so each one laps over the next by the thickness of the sheet
 * and no seam can open on the outside of a bend.  What that costs is that a
 * point ends up with the colour of the piece one or two ahead of it, which is
 * two per cent of the length of the sheet and two per cent of the ramp.
 *
 * The two pieces at the ends are drawn with a square cap instead: their inner
 * end is lapped over by the piece next to them anyway, so the only ends left
 * showing square are the two cut ends of the sheet.
 */
const CHUNKS = 40
const PIECES = (() => {
  const per = TOTAL / CHUNKS
  const out = []
  let pts = [PATH[0]]
  let acc = 0
  let startAt = 0
  for (let i = 1; i < PATH.length; i++) {
    pts.push(PATH[i])
    acc += SEG[i - 1].len
    if (acc >= per && out.length < CHUNKS - 1) {
      out.push({ pts, t: (startAt + acc / 2) / TOTAL })
      startAt += acc
      pts = [PATH[i]]
      acc = 0
    }
  }
  // a piece has to be at least two points to be a stroke at all; if the last
  // one is a single point left over, the piece before it already ends there
  if (pts.length > 1) out.push({ pts, t: (startAt + acc / 2) / TOTAL })
  return out
})()

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Mendeley NG">
  <!-- generated by scripts/make-icon.mjs; edit the shapes there, not here -->
  <g fill="none" stroke-width="${HALF * 2}" stroke-linecap="round" stroke-linejoin="round">
${PIECES.map((p, i) => '  ' + stroke(p.pts, toHex(rampAt(p.t)), i === 0 || i === PIECES.length - 1 ? 'butt' : '')).join('\n')}
  </g>
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
