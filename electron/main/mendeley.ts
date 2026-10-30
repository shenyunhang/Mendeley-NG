import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Doc, Folder } from '../../shared/types'

const BASE = 'https://api.mendeley.com'
const TOKEN_URL = BASE + '/oauth/token'

/** Cloudflare in front of api.mendeley.com answers error 1010 to anything that
 *  looks like a script, and that includes /oauth/token.  Every request has to
 *  go out with a browser User-Agent or the whole thing silently fails. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const CT_DOC = 'application/vnd.mendeley-document.1+json'
const CT_FOLDER = 'application/vnd.mendeley-folder.1+json'

interface Token {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  client_id?: string
  client_secret?: string
  _expires_at?: number
}

export class Mendeley {
  private tok: Token
  private tokenPath: string

  constructor(tokenPath: string, tok: Token) {
    this.tokenPath = tokenPath
    this.tok = tok
    if (!this.tok._expires_at) {
      this.tok._expires_at =
        Date.now() / 1000 + (this.tok.expires_in ?? 3600) - 60
    }
  }

  private save() {
    try {
      fs.writeFileSync(
        this.tokenPath,
        JSON.stringify(this.tok, null, 2),
        'utf-8'
      )
    } catch {
      /* a read-only token file is not fatal; we keep the refresh in memory */
    }
  }

  private async refresh() {
    const rt = this.tok.refresh_token
    if (!rt) throw new Error('no refresh_token; re-authorisation needed')
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rt
    })
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Accept: '*/*'
    }
    if (this.tok.client_id && this.tok.client_secret) {
      const b = Buffer.from(
        `${this.tok.client_id}:${this.tok.client_secret}`
      ).toString('base64')
      headers.Authorization = 'Basic ' + b
    }
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers,
      body: body.toString()
    })
    if (!res.ok) {
      throw new Error(`token refresh failed: ${res.status} ${await res.text()}`)
    }
    const fresh = (await res.json()) as Token
    this.tok = { ...this.tok, ...fresh }
    this.tok._expires_at =
      Date.now() / 1000 + (fresh.expires_in ?? 3600) - 60
    this.save()
  }

  async request<T = unknown>(
    method: string,
    p: string,
    opts: {
      params?: Record<string, string>
      body?: unknown
      contentType?: string
      retried?: boolean
    } = {}
  ): Promise<T> {
    if ((this.tok._expires_at ?? 0) < Date.now() / 1000) await this.refresh()

    let url = BASE + p
    if (opts.params) {
      url += '?' + new URLSearchParams(opts.params).toString()
    }
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + this.tok.access_token,
      'User-Agent': UA,
      Accept: '*/*'
    }
    let payload: string | undefined
    if (opts.body !== undefined) {
      headers['Content-Type'] = opts.contentType ?? CT_DOC
      payload = JSON.stringify(opts.body)
    }
    const res = await fetch(url, { method, headers, body: payload })

    if (res.status === 401 && !opts.retried) {
      await this.refresh()
      return this.request<T>(method, p, { ...opts, retried: true })
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`${method} ${p} -> ${res.status} ${txt.slice(0, 300)}`)
    }
    if (res.status === 204) return undefined as T
    const txt = await res.text()
    return (txt.trim() ? JSON.parse(txt) : undefined) as T
  }

  /** Full pull.  `view=all` is mandatory: the default view omits
   *  citation_key, file_attached and folder_uuids. */
  async allDocuments(onPage?: (n: number) => void): Promise<Doc[]> {
    const out: Doc[] = []
    const params: Record<string, string> = { limit: '100', view: 'all' }
    for (let guard = 0; guard < 200; guard++) {
      const batch = await this.request<Doc[]>('GET', '/documents', { params })
      if (!batch || batch.length === 0) break
      out.push(...batch)
      onPage?.(out.length)
      if (batch.length < 100) break
      params.marker = batch[batch.length - 1].id
    }
    return out
  }

  async allFolders(): Promise<Folder[]> {
    const out: Folder[] = []
    const params: Record<string, string> = { limit: '200' }
    for (let guard = 0; guard < 20; guard++) {
      const batch = await this.request<Folder[]>('GET', '/folders', { params })
      if (!batch || batch.length === 0) break
      out.push(...batch)
      if (batch.length < 200) break
      params.marker = batch[batch.length - 1].id
    }
    return out
  }

  /** Document ids that actually carry a file.  file_attached lies often
   *  enough to be worth cross-checking against this. */
  async fileDocumentIds(): Promise<Set<string>> {
    const ids = new Set<string>()
    const params: Record<string, string> = { limit: '200' }
    for (let guard = 0; guard < 200; guard++) {
      const batch = await this.request<{ document_id?: string }[]>(
        'GET',
        '/files',
        { params }
      )
      if (!batch || batch.length === 0) break
      for (const f of batch) if (f.document_id) ids.add(f.document_id)
      if (batch.length < 200) break
      params.marker = batch[batch.length - 1].document_id ?? ''
      if (!params.marker) break
    }
    return ids
  }

  async patchDocument(id: string, body: Record<string, unknown>): Promise<Doc> {
    return this.request<Doc>('PATCH', '/documents/' + id, {
      body,
      contentType: CT_DOC
    })
  }

  async createFolder(name: string, parentId?: string): Promise<Folder> {
    const body: Record<string, string> = { name }
    if (parentId) body.parent_id = parentId
    return this.request<Folder>('POST', '/folders', {
      body,
      contentType: CT_FOLDER
    })
  }

  /** Move to trash.  Mendeley has no hard delete for documents. */
  async trashDocument(id: string): Promise<void> {
    await this.request('POST', `/documents/${id}/trash`)
  }

  async listTrash(): Promise<Doc[]> {
    const out: Doc[] = []
    const params: Record<string, string> = { limit: '100', view: 'all' }
    for (let guard = 0; guard < 100; guard++) {
      const batch = await this.request<Doc[]>('GET', '/trash', { params })
      if (!batch || batch.length === 0) break
      out.push(...batch)
      if (batch.length < 100) break
      params.marker = batch[batch.length - 1].id
    }
    return out
  }

  /** Restore from trash.  Undocumented but stable, and the web client uses it. */
  async restoreDocument(id: string): Promise<Doc> {
    return this.request<Doc>('POST', `/trash/${id}/restore`)
  }

  /** Rename, or move by passing a new parent_id (null moves it to the root). */
  async patchFolder(id: string, body: { name?: string; parent_id?: string | null }): Promise<Folder> {
    return this.request<Folder>('PATCH', '/folders/' + id, {
      body,
      contentType: CT_FOLDER
    })
  }

  async deleteFolder(id: string): Promise<void> {
    await this.request('DELETE', '/folders/' + id)
  }

  async addToFolder(folderId: string, docId: string): Promise<void> {
    await this.request('POST', `/folders/${folderId}/documents`, {
      body: { id: docId }
    })
  }

  async removeFromFolder(folderId: string, docId: string): Promise<void> {
    await this.request('DELETE', `/folders/${folderId}/documents/${docId}`)
  }
}

/** Look for an existing token in the obvious places, so the app can reuse the
 *  credentials the CLI scripts already produced instead of asking the user to
 *  authorise again. */
export function findToken(): { path: string; tok: Token } | null {
  const candidates = [
    path.join(app.getPath('userData'), 'token.json'),
    path.join(app.getPath('userData'), 'mendeley-token.json')
  ]
  // an explicit override keeps this generic; nothing machine-specific belongs
  // in the source tree
  if (process.env.MENDELEY_TOKEN_PATH) candidates.push(process.env.MENDELEY_TOKEN_PATH)
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const tok = JSON.parse(fs.readFileSync(c, 'utf-8')) as Token
        if (tok.access_token) return { path: c, tok }
      }
    } catch {
      /* ignore unreadable candidates */
    }
  }
  return null
}

export function importTokenFrom(src: string): { path: string; tok: Token } {
  const tok = JSON.parse(fs.readFileSync(src, 'utf-8')) as Token
  if (!tok.access_token) throw new Error('token file has no access_token')
  const dest = path.join(app.getPath('userData'), 'token.json')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  tok._expires_at = Date.now() / 1000 + (tok.expires_in ?? 3600) - 60
  fs.writeFileSync(dest, JSON.stringify(tok, null, 2), 'utf-8')
  return { path: dest, tok }
}
