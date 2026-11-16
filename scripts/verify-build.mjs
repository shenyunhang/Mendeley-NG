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

console.log('build artifacts OK')
