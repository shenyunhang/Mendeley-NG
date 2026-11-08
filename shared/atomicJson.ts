import fs from 'node:fs'

/** Write JSON to a temp file beside the destination and rename it into place,
 *  so a process killed mid-write leaves the previous complete file intact.
 *  `space` mirrors JSON.stringify's indent: the config stays hand-editable,
 *  the compact tables stay compact. */
export function atomicWriteJson(file: string, value: unknown, space?: number | string) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, space), 'utf-8')
  fs.renameSync(tmp, file)
}
