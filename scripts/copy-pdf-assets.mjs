// Copies pdf.js's binary CMaps and standard font programs into Vite's public
// dir before dev/build.  They are not JS modules, so Vite cannot discover them
// from an import: pdf.js builds their URLs at runtime by appending a file name
// to `cMapUrl` / `standardFontDataUrl`.
//
// The directory is generated from node_modules and gitignored.  Vite's
// publicDir copies it verbatim into out/renderer/, which is where the packaged
// app looks for it (see build.asarUnpack in package.json).

import fs from 'node:fs'
import path from 'node:path'
import { root } from './_shared.mjs'

const packageDir = path.join(root, 'node_modules', 'pdfjs-dist')
const destination = path.join(root, '.pdfjs-assets')
const directories = ['cmaps', 'standard_fonts']

for (const name of directories) {
  const source = path.join(packageDir, name)
  if (!fs.existsSync(source)) {
    console.error('pdf.js font resources not found at', source)
    process.exit(1)
  }
}

// Mirror the two source directories instead of wiping the whole generated
// tree first. Those ~185 files are about to be written again unchanged, and
// deleting them all on every prebuild is both the slow part and a bulk-delete
// that some managed environments refuse outright. Entries that no longer
// exist upstream are removed one by one, so a pdfjs-dist upgrade still leaves
// an exact mirror.
fs.mkdirSync(destination, { recursive: true })
for (const name of directories) {
  const source = path.join(packageDir, name)
  const target = path.join(destination, name)
  fs.mkdirSync(target, { recursive: true })
  const wanted = new Set(fs.readdirSync(source))
  for (const entry of fs.readdirSync(target)) {
    if (!wanted.has(entry)) {
      fs.rmSync(path.join(target, entry), { recursive: true, force: true })
    }
  }
  fs.cpSync(source, target, { recursive: true, force: true })
  const count = fs.readdirSync(target).length
  console.log(`copied ${name} (${count} files) -> ${path.relative(root, target)}`)
}
