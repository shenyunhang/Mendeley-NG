// Puts pdf.js's worker next to the bundled main process.
//
// The full-text indexer runs pdf.js in the main process, and pdf.js reaches
// its worker with a runtime `import()` relative to the module asking for it.
// After bundling that is out/main/, so the worker has to be copied there or
// every PDF fails to open with "Setting up fake worker failed".

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(
  root,
  'node_modules',
  'pdfjs-dist',
  'legacy',
  'build',
  'pdf.worker.mjs'
)
const destDir = path.join(root, 'out', 'main')
const dest = path.join(destDir, 'pdf.worker.mjs')

if (!fs.existsSync(src)) {
  console.error('pdf.js worker not found at', src)
  process.exit(1)
}
fs.mkdirSync(destDir, { recursive: true })
fs.copyFileSync(src, dest)
console.log('copied pdf.worker.mjs ->', path.relative(root, dest))
