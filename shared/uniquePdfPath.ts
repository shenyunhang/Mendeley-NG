import fs from 'node:fs'
import path from 'node:path'

/** Candidate names for `wanted` inside `dir`, in the order they are tried.
 *  Two papers can legitimately want the same name, and the caller has to move
 *  to the next candidate rather than overwrite an existing PDF. */
export function* pdfCandidates(dir: string, wanted: string): Generator<string> {
  yield path.join(dir, wanted)
  for (let n = 2; n < 50; n++) {
    yield path.join(dir, wanted.replace(/\.pdf$/, ` (${n}).pdf`))
  }
}

/** A free path for `wanted` inside `dir`, or null when every candidate is
 *  taken.  `exists` is injectable so the naming rule can be checked without a
 *  real directory.  This only answers a question about names: writing bytes
 *  belongs to writeUniquePdf, which claims the name atomically. */
export function uniquePdfPath(
  dir: string,
  wanted: string,
  exists: (p: string) => boolean = (p) => fs.existsSync(p)
): string | null {
  for (const candidate of pdfCandidates(dir, wanted)) {
    if (!exists(candidate)) return candidate
  }
  return null
}

/** Write `buf` under the first free candidate name and return the path used.
 *
 *  `flag: 'wx'` makes "is this name free" and "claim it" one operation.
 *  Checking with existsSync first and writing afterwards lets two concurrent
 *  imports be handed the same free path, and the second silently overwrites
 *  the first paper's bytes -- the exact failure the unique-name rule exists
 *  to prevent.  EEXIST means somebody else won the race, so try the next
 *  candidate; any other error belongs to the caller. */
export function writeUniquePdf(
  dir: string,
  wanted: string,
  buf: Uint8Array
): string | null {
  for (const candidate of pdfCandidates(dir, wanted)) {
    try {
      fs.writeFileSync(candidate, buf, { flag: 'wx' })
      return candidate
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  return null
}
