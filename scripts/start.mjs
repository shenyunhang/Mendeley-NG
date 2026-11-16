/**
 * Launcher for the built app.
 *
 * Some shells (notably inside Electron-based IDEs) export ELECTRON_RUN_AS_NODE=1.
 * When that variable is set, electron.exe boots as plain Node and
 * require('electron') hands back the binary path instead of the API, so the main
 * process dies on `app.whenReady()` with "Cannot read properties of undefined".
 * Stripping the variable here makes `npm start` work from anywhere.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { root, electronBin, cleanEnv, propagateExit } from './_shared.mjs'

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))
const bin = electronBin()

if (!fs.existsSync(path.join(root, 'out/main/index.js'))) {
  console.error('out/ 不存在，先跑 npm run build')
  process.exit(1)
}

const env = cleanEnv()

// A smoke run must not spend four minutes reading every PDF, and must not
// touch the real full-text index, so it gets its own throwaway one and a
// short document list.
if (process.argv.includes('--smoke')) {
  env.MENDELEY_FT_DIR ??= path.join(root, '.ft-smoke')
  env.MENDELEY_FT_LIMIT ??= '80'
  // a throwaway index is only throwaway if each run gets a fresh one, or the
  // "index starts empty" check starts failing on the second run
  fs.rmSync(env.MENDELEY_FT_DIR, { recursive: true, force: true })
}

const args = [root, ...process.argv.slice(2)]
const child = spawn(bin, args, { stdio: 'inherit', env, cwd: root })
propagateExit(child)
console.error('launching', path.basename(bin), pkg.version)
