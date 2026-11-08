import fs from 'node:fs'
import path from 'node:path'

/** A free path for `wanted` inside `dir`, or null when every candidate is
 *  taken.  Two papers can legitimately want the same name, and the caller has
 *  to skip rather than overwrite an existing PDF.  `exists` is injectable so
 *  the naming rule can be checked without a real directory. */
export function uniquePdfPath(
  dir: string,
  wanted: string,
  exists: (p: string) => boolean = (p) => fs.existsSync(p)
): string | null {
  const first = path.join(dir, wanted)
  if (!exists(first)) return first
  for (let n = 2; n < 50; n++) {
    const candidate = path.join(dir, wanted.replace(/\.pdf$/, ` (${n}).pdf`))
    if (!exists(candidate)) return candidate
  }
  return null
}
