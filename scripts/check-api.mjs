// Standalone smoke test for the data layer: proves the token still works and
// that the API answers, before any window is involved.
import fs from 'node:fs'
import path from 'node:path'
import { root, UA } from './_shared.mjs'

const BASE = 'https://api.mendeley.com'

// token location: first argument, else MENDELEY_TOKEN_PATH, else repo-root
// token.json (the same file scripts/get-token.mjs writes).
const TOKEN_PATH =
  process.argv[2] || process.env.MENDELEY_TOKEN_PATH || path.join(root, 'token.json')

function readToken() {
  let text
  try {
    text = fs.readFileSync(TOKEN_PATH, 'utf-8')
  } catch (e) {
    throw new Error(`读不到 ${TOKEN_PATH}：${String(e)}。先跑 scripts/get-token.mjs 或指定路径。`)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`${TOKEN_PATH} 不是合法 JSON：${String(e)}`)
  }
}

let tok
try {
  tok = readToken()
} catch (e) {
  console.error('check-api 失败:', String(e))
  process.exit(1)
}

async function refresh() {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': UA,
    Accept: '*/*'
  }
  if (tok.client_id && tok.client_secret) {
    headers.Authorization =
      'Basic ' +
      Buffer.from(`${tok.client_id}:${tok.client_secret}`).toString('base64')
  }
  const res = await fetch(BASE + '/oauth/token', {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token
    }).toString()
  })
  if (!res.ok) throw new Error('refresh ' + res.status + ' ' + (await res.text()).slice(0, 200))
  return res.json()
}

async function get(pathname, params, token) {
  const u = BASE + pathname + (params ? '?' + new URLSearchParams(params) : '')
  const r = await fetch(u, {
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': UA, Accept: '*/*' }
  })
  if (!r.ok) return { status: r.status, body: (await r.text()).slice(0, 200) }
  return { status: r.status, json: await r.json() }
}

async function main() {
  let token = tok.access_token
  let r = await get('/documents', { limit: '3', view: 'all' }, token)
  console.log('1) 直接用现有 access_token ->', r.status)
  if (r.status === 401) {
    console.log('   过期，尝试 refresh…')
    const fresh = await refresh()
    token = fresh.access_token
    console.log('   refresh OK, 新 token 长度', token.length)
    r = await get('/documents', { limit: '3', view: 'all' }, token)
    console.log('2) 用新 token ->', r.status)
  }
  if (Array.isArray(r.json) && r.json.length > 0) {
    const d = r.json[0]
    console.log('3) 拿到', r.json.length, '条样例，字段检查:')
    for (const k of ['id', 'title', 'year', 'citation_key', 'file_attached', 'folder_uuids']) {
      console.log('   ', k.padEnd(14), k in d ? '✓' : '✗ 缺失')
    }
    console.log('   标题:', (d.title || '').slice(0, 60))
  } else if (r.json) {
    console.log('3) /documents 返回了 0 条样例（库是空的，或响应不是数组）')
  } else {
    console.log('3) /documents 没有返回 JSON:', r.status, r.body ?? '')
  }
  const f = await get('/folders', { limit: '5' }, token)
  console.log('4) /folders ->', f.status, f.json ? f.json.length + ' 个' : f.body ?? '')
}

main().catch((e) => {
  console.error('check-api 失败:', String(e))
  process.exitCode = 1
})
