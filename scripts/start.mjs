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
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))
const bin = process.platform === 'win32'
  ? path.join(root, 'node_modules/electron/dist/electron.exe')
  : path.join(root, 'node_modules/electron/dist/electron')

if (!fs.existsSync(path.join(root, 'out/main/index.js'))) {
  console.error('out/ 不存在，先跑 npm run build')
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

const args = [root, ...process.argv.slice(2)]
const child = spawn(bin, args, { stdio: 'inherit', env, cwd: root })
child.on('close', (code) => process.exit(code ?? 0))
console.error('launching', path.basename(bin), pkg.version)
