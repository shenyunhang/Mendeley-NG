import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import type { SmokeCtx } from './smoke-ctx'

export function iconPixels(ctx: SmokeCtx) {
    const decodeIconPng = (buf: Buffer) => {
      let off = 8
      let n = 0
      const parts: Buffer[] = []
      while (off + 12 <= buf.length) {
        const len = buf.readUInt32BE(off)
        const type = buf.toString('ascii', off + 4, off + 8)
        const data = buf.subarray(off + 8, off + 8 + len)
        if (type === 'IHDR') n = data.readUInt32BE(0)
        if (type === 'IDAT') parts.push(data)
        off += 12 + len
      }
      const raw = zlib.inflateSync(Buffer.concat(parts))
      const stride = n * 4
      const rgba = new Uint8Array(stride * n)
      for (let y = 0; y < n; y++) {
        const at = y * (stride + 1)
        if (raw[at] !== 0) throw new Error('unexpected PNG row filter')
        for (let x = 0; x < stride; x++) rgba[y * stride + x] = raw[at + 1 + x]
      }
      return { n, rgba }
    }
    const iconDir = path.join(app.getAppPath(), 'assets')
    const { n, rgba } = decodeIconPng(fs.readFileSync(path.join(iconDir, 'icon.png')))
    const alphaAt = (x: number, y: number) => rgba[(y * n + x) * 4 + 3]
    const corners = [
      alphaAt(0, 0), alphaAt(n - 1, 0), alphaAt(0, n - 1), alphaAt(n - 1, n - 1)
    ]
    let opaque = 0
    let warm = 0
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i]
      const b = rgba[i + 2]
      if (rgba[i + 3] < 200) continue
      opaque++
      // red, orange and yellow all have a red channel well above blue; the
      // new mark is violet -> blue -> cyan and has none of them
      if (r > b + 40 && r > 140) warm++
    }
    ctx.expect(
      'the icon has no tile behind it',
      corners.every((a) => a === 0),
      { corners, n }
    )
    ctx.expect(
      'the icon stays in one cool colour family',
      opaque > (n * n) / 20 && warm === 0,
      { opaque, warm, n }
    )
    // The official mark has three separate discs along the bottom and one
    // round hole in the middle. Counting opaque runs on two scanlines is a
    // shape assertion, not a colour one: a recoloured blob would still fail.
    const runsAt = (fy: number) => {
      const y = Math.round(n * fy)
      let runs = 0
      let inRun = false
      for (let x = 0; x < n; x++) {
        const on = rgba[(y * n + x) * 4 + 3] > 200
        if (on && !inRun) runs++
        inRun = on
      }
      return runs
    }
    ctx.expect(
      'the mark still has its three bottom discs',
      runsAt(0.66) === 3 && runsAt(0.7) === 3,
      { low: runsAt(0.66), lower: runsAt(0.7) }
    )
    ctx.expect(
      'the mark still has the round hole between the upper lobes',
      runsAt(0.45) === 2 && runsAt(0.5) === 2,
      { mid: runsAt(0.45), centre: runsAt(0.5) }
    )
    // Colour is the part that changed: the official logo is one flat dark
    // colour, this one runs from violet on the left to cyan on the right.
    const edgeColour = (fromRight: boolean) => {
      const y = Math.round(n * 0.7)
      for (let k = 0; k < n; k++) {
        const x = fromRight ? n - 1 - k : k
        if (rgba[(y * n + x) * 4 + 3] < 200) continue
        const o = (y * n + x) * 4
        return [rgba[o], rgba[o + 1], rgba[o + 2]]
      }
      return null
    }
    const leftEdge = edgeColour(false)
    const rightEdge = edgeColour(true)
    // Violet #6d3bf5 is blue-dominant in RGB, not red-dominant: asking for
    // r > b on the left was a detector that could never pass (166). What
    // actually separates the two ends is the green channel and the red
    // channel falling away as the ramp runs left to right.
    ctx.expect(
      'the colour was changed to violet-to-cyan, not the official flat black',
      !!leftEdge &&
        !!rightEdge &&
        Math.abs(leftEdge[1] - rightEdge[1]) > 80 &&
        leftEdge[0] > rightEdge[0] + 40 &&
        Math.max(...leftEdge) > 150 &&
        Math.max(...rightEdge) > 150,
      { leftEdge, rightEdge }
    )

    const svgText = fs.readFileSync(path.join(iconDir, 'logo.svg'), 'utf8')
    ctx.expect(
      'the vector source is one even-odd path with a gradient and no masks',
      !svgText.includes('<mask') &&
        !svgText.includes('stroke-dasharray') &&
        svgText.includes('fill-rule="evenodd"') &&
        svgText.includes('<linearGradient') &&
        svgText.length < 4096,
      { bytes: svgText.length }
    )
    const genText = fs.readFileSync(
      path.join(app.getAppPath(), 'scripts', 'make-icon.mjs'),
      'utf8'
    )
    ctx.expect(
      'the vector and every raster come from the same Mendeley ring table',
      genText.includes('const RINGS = [') &&
        genText.includes('RINGS.map(ringPath)') &&
        genText.includes('for (const ring of RINGS)') &&
        !genText.includes('const ROLL') &&
        !genText.includes('const SLIP') &&
        !genText.includes('const CORD') &&
        (genText.match(/^  \[0\.0, \[/m) ?? []).length === 1 &&
        (genText.match(/^  \[1\.0, \[/m) ?? []).length === 1,
      { bytes: genText.length }
    )
    // A detector that cannot see the old shape table would report "all clear"
    // for either generator (168).
    const oldMarkLine = 'const ROLL = {\n  turns: 1.15'
    const ringTables = (t: string) => (t.match(/const RINGS = \[/g) ?? []).length
    ctx.expect(
      'the ring detector can tell the old generator from the new one',
      ringTables(oldMarkLine) === 0 && ringTables('const RINGS = [') === 1,
      {}
    )
}
