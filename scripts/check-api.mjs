// Standalone smoke test for the data layer: proves the token still works and
// that the API answers, before any window is involved.
import fs from 'node:fs'

const BASE = 'https://api.mendeley.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const tok = JSON.parse(
  fs.readFileSync(
    'C:\\Users\\shenyunhang\\WorkBuddy\\2026-10-19-15-35-36\\mendeley_work\\token.json',
    'utf-8'
  )
)

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

async function get(path, params, token) {
  const u = BASE + path + (params ? '?' + new URLSearchParams(params) : '')
  const r = await fetch(u, {
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': UA, Accept: '*/*' }
  })
  if (!r.ok) return { status: r.status, body: (await r.text()).slice(0, 200) }
  return { status: r.status, json: await r.json() }
}

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
if (r.json) {
  const d = r.json[0]
  console.log('3) 拿到', r.json.length, '条样例，字段检查:')
  for (const k of ['id', 'title', 'year', 'citation_key', 'file_attached', 'folder_uuids']) {
    console.log('   ', k.padEnd(14), k in d ? '✓' : '✗ 缺失')
  }
  console.log('   标题:', (d.title || '').slice(0, 60))
}
const f = await get('/folders', { limit: '5' }, token)
console.log('4) /folders ->', f.status, f.json ? f.json.length + ' 个' : '')
