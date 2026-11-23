/**
 * Check the build artifacts themselves, not just that vite exited 0.
 *
 * This is the single copy of what ci.yml and release.yml both used to inline
 * as a 39-line `node -e` block. electron-vite can emit a broken entry point,
 * drop the --smoke chunk, or fail to copy the pdf.js worker; all of those
 * only show up at runtime on an installed machine. Keeping the check in one
 * file means the push gate and the release gate cannot drift apart.
 *
 * Run it after `npm run build`:  node scripts/verify-build.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { root } from './_shared.mjs'

const mainDir = path.join(root, 'out', 'main')
const fail = (msg) => {
  console.error('build artifact check FAILED: ' + msg)
  process.exit(1)
}

if (!fs.existsSync(mainDir)) fail('missing directory ' + mainDir)
const entries = fs.readdirSync(mainDir)
const smokeChunks = entries.filter((name) => /^smoke-.*\.js$/.test(name))
if (smokeChunks.length === 0) fail('no out/main/smoke-*.js chunk was produced')

const toCheck = [path.join(mainDir, 'index.js')]
for (const name of smokeChunks) toCheck.push(path.join(mainDir, name))
for (const file of toCheck) {
  if (!fs.existsSync(file)) fail('missing ' + file)
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (e) {
    fail('node --check failed for ' + file + '\n' + String(e.stderr || e.message))
  }
  console.log('node --check OK  ' + path.relative(root, file))
}

const preload = path.join(root, 'out', 'preload', 'index.js')
const renderer = path.join(root, 'out', 'renderer', 'index.html')
if (!fs.existsSync(preload)) fail('missing ' + preload)
if (!fs.existsSync(renderer)) fail('missing ' + renderer)
console.log('preload + renderer OK')

const worker = path.join(mainDir, 'pdf.worker.mjs')
if (!fs.existsSync(worker)) fail('missing ' + worker)
const workerSize = fs.statSync(worker).size
if (!(workerSize > 100000)) fail(worker + ' is ' + workerSize + ' bytes; expected > 100000')
console.log('pdf.worker.mjs OK  ' + workerSize + ' bytes')

// The binary CMaps and standard font programs are public assets, not JS
// imports, so Vite cannot tell us they were copied.  Without them a CID font
// with no /ToUnicode fails to load and the canvas drops its glyphs: boxes and
// arrows still draw, labels do not.
const rendererDir = path.join(root, 'out', 'renderer')
const cMapDir = path.join(rendererDir, 'cmaps')
const fontDir = path.join(rendererDir, 'standard_fonts')
const cMap = path.join(cMapDir, 'Adobe-GB1-UCS2.bcmap')
const standardFont = path.join(fontDir, 'FoxitSerif.pfb')
if (!fs.existsSync(cMap)) fail('missing ' + cMap)
const cMapSize = fs.statSync(cMap).size
if (!(cMapSize > 30000)) fail(cMap + ' is ' + cMapSize + ' bytes; expected > 30000')
if (!fs.existsSync(standardFont)) fail('missing ' + standardFont)
const cMapCount = fs.readdirSync(cMapDir).length
const fontCount = fs.readdirSync(fontDir).length
if (!(cMapCount > 100)) fail('cmaps has only ' + cMapCount + ' files')
if (!(fontCount >= 10)) fail('standard_fonts has only ' + fontCount + ' files')
console.log('font resources OK  ' + cMapCount + ' cmaps, ' + fontCount + ' fonts')

const indexSrc = fs.readFileSync(path.join(mainDir, 'index.js'), 'utf8')
const re = /require\(\s*["']\.\/(smoke-[^"']+\.js)["']\s*\)/g
const referenced = new Set()
let match
while ((match = re.exec(indexSrc)) !== null) referenced.add(match[1])
if (referenced.size === 0) fail('index.js has no require("./smoke-<hash>.js") reference')
for (const name of referenced) {
  const chunk = path.join(mainDir, name)
  if (!fs.existsSync(chunk)) fail('index.js requires missing chunk ' + chunk)
  console.log('smoke chunk OK  ' + path.relative(root, chunk))
}

// The two chains that put the worker into an installed package. The smoke
// suite checks these source strings locally; doing it here as well makes the
// hosted gates catch a build/dist edit that forgets the other half.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const scripts = pkg.scripts ?? {}
if (!/copy-worker/.test(scripts.build ?? '')) fail('build script no longer copies the pdf.js worker')
if (!/npm run build/.test(scripts.dist ?? '')) fail('dist script no longer delegates to npm run build')
console.log('build/dist wiring OK')

// The font resources have two more links in that chain: a prebuild/predev
// step that fills Vite's publicDir, and an asarUnpack rule so Chromium can
// fetch them in an installed app (it cannot read files inside app.asar).
if (!/copy-pdf-assets/.test(scripts.prebuild ?? '')) fail('prebuild no longer copies pdf.js font resources')
if (!/copy-pdf-assets/.test(scripts.predev ?? '')) fail('predev no longer copies pdf.js font resources')
const viteConfig = fs.readFileSync(path.join(root, 'electron.vite.config.ts'), 'utf8')
if (!/\.pdfjs-assets/.test(viteConfig)) fail('renderer publicDir no longer points at the generated font resources')
const unpack = pkg.build?.asarUnpack ?? []
if (!unpack.some((p) => /out\/renderer\/cmaps/.test(p))) fail('build.asarUnpack no longer unpacks cmaps')
if (!unpack.some((p) => /out\/renderer\/standard_fonts/.test(p))) fail('build.asarUnpack no longer unpacks standard_fonts')
console.log('font resource wiring OK')

console.log('build artifacts OK')
