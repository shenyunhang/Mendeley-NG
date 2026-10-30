/**
 * Walk the Mendeley OAuth authorization-code flow once and write token.json.
 *
 *   node scripts/get-token.mjs <client_id> <client_secret>
 *
 * The two arguments come from your own app registration at
 * https://dev.mendeley.com/myapps.html — there is no shared credential for
 * this project, so everyone has to register their own.
 *
 * The redirect URI is http://localhost:8080/, which never needs to be
 * reachable: after you approve, the browser simply fails to load it and the
 * `code` you need stays in the address bar.  Paste that code back in here.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { fileURLToPath } from 'node:url'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const REDIRECT = 'http://localhost:8080/'
const TOKEN_URL = 'https://api.mendeley.com/oauth/token'
const AUTH_URL = 'https://api.mendeley.com/oauth/authorize'

const [clientId, clientSecret] = process.argv.slice(2)
if (!clientId || !clientSecret) {
  console.error('用法: node scripts/get-token.mjs <client_id> <client_secret>')
  process.exit(1)
}

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'token.json')
if (fs.existsSync(out)) {
  console.error(`${out} 已存在，先删掉或改名再重跑`)
  process.exit(1)
}

const authorize =
  `${AUTH_URL}?client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  '&response_type=code&scope=all'

console.log('1) 在浏览器打开下面这个地址并授权：\n')
console.log(authorize + '\n')
console.log('2) 授权后浏览器会跳到一个打不开的 localhost 地址，这是正常的。')
console.log('   把地址栏里 ?code= 后面那一段复制下来。\n')

const rl = readline.createInterface({ input, output })
const code = (await rl.question('粘贴 code: ')).trim()
rl.close()

if (!code) {
  console.error('没有 code，退出')
  process.exit(1)
}

// Cloudflare in front of api.mendeley.com answers error 1010 to anything that
// does not look like a browser, /oauth/token included.
const res = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization:
      'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    'User-Agent': UA,
    Accept: '*/*'
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT
  }).toString()
})

const text = await res.text()
if (!res.ok) {
  console.error('换 token 失败:', res.status, text.slice(0, 400))
  process.exit(1)
}

const tok = JSON.parse(text)
tok.client_id = clientId
tok.client_secret = clientSecret
fs.writeFileSync(out, JSON.stringify(tok, null, 2), 'utf-8')
console.log(`\n已写入 ${out}`)
console.log('token.json 已在 .gitignore 里，不会被提交。')
console.log('启动应用后点工具栏「导入 token」选中它即可。')
