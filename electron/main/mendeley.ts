import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { CloudAnnotation, Doc, Folder } from '../../shared/types'

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
const CT_ANNOTATION = 'application/vnd.mendeley-annotation.1+json'

/** What GET /files tells us about an attachment. */
export interface FileMeta {
  id: string
  document_id?: string
  file_name?: string
  mime_type?: string
  size?: number
  filehash?: string
}

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

  /** A bearer token for callers that talk to Mendeley without going through
   *  `request`, which is what the catalogue lookup in lookup.ts does.  GET
   *  /catalog answers 401 "No auth header" anonymously, so it cannot be used
   *  without this. */
  async bearer(): Promise<string> {
    if ((this.tok._expires_at ?? 0) < Date.now() / 1000) await this.refresh()
    return this.tok.access_token
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

  /** Metadata of the file attached to a document, or null when there is none. */
  async fileMeta(documentId: string): Promise<FileMeta | null> {
    const r = await this.request<FileMeta[]>('GET', '/files', {
      params: { document_id: documentId, limit: '1' }
    })
    return r?.[0] ?? null
  }

  /**
   * GET /files/{id} answers 303 to a presigned S3 URL rather than returning
   * the bytes, so it cannot go through `request`, which would try to parse
   * the PDF as JSON.
   */
  async downloadFile(fileId: string): Promise<Buffer> {
    if ((this.tok._expires_at ?? 0) < Date.now() / 1000) await this.refresh()
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + this.tok.access_token,
      'User-Agent': UA,
      Accept: '*/*'
    }
    let res = await fetch(`${BASE}/files/${fileId}`, {
      headers,
      redirect: 'manual'
    })
    if (res.status === 401) {
      await this.refresh()
      headers.Authorization = 'Bearer ' + this.tok.access_token
      res = await fetch(`${BASE}/files/${fileId}`, { headers, redirect: 'manual' })
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error(`download ${fileId}: ${res.status} without location`)
      // the signed URL is self-contained, so no auth header goes with it
      res = await fetch(loc, { headers: { 'User-Agent': UA } })
    }
    if (!res.ok) throw new Error(`download ${fileId} -> ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  async createDocument(body: Record<string, unknown>): Promise<Doc> {
    return this.request<Doc>('POST', '/documents', {
      body,
      contentType: CT_DOC
    })
  }

  /**
   * Create a document straight from a file.  This is not JSON: the PDF goes
   * in as the raw body with two headers, and the server creates the record
   * *and* attaches the file in one request.  It only ever takes the title
   * from the file name, so anything else has to be patched afterwards.
   */
  async createDocumentFromFile(fileName: string, data: Buffer): Promise<Doc> {
    if ((this.tok._expires_at ?? 0) < Date.now() / 1000) await this.refresh()
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + this.tok.access_token,
      'User-Agent': UA,
      Accept: '*/*',
      'Content-Type': 'application/pdf',
      // the server parses the file name out of this header
      'Content-Disposition': `attachment; filename="${fileName.replace(/["\r\n]/g, '')}"`
    }
    let res = await fetch(`${BASE}/documents`, {
      method: 'POST',
      headers,
      body: data
    })
    if (res.status === 401) {
      await this.refresh()
      headers.Authorization = 'Bearer ' + this.tok.access_token
      res = await fetch(`${BASE}/documents`, { method: 'POST', headers, body: data })
    }
    if (!res.ok) {
      throw new Error(`create from file -> ${res.status} ${(await res.text()).slice(0, 200)}`)
    }
    return (await res.json()) as Doc
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

  /** Annotations for one document.  Highlight positions are absolute PDF
   *  points, not the normalised 0..1 rects we keep locally. */
  async listAnnotations(documentId: string): Promise<CloudAnnotation[]> {
    const out: CloudAnnotation[] = []
    const params: Record<string, string> = {
      document_id: documentId,
      limit: '200'
    }
    for (let guard = 0; guard < 50; guard++) {
      const batch = await this.request<CloudAnnotation[]>('GET', '/annotations', {
        params
      })
      if (!batch || batch.length === 0) break
      out.push(...batch)
      if (batch.length < 200) break
      params.marker = batch[batch.length - 1].id
    }
    return out
  }

  /**
   * The live API is picky here, and getting it wrong silently downgrades the
   * annotation instead of failing:
   *   - no filehash  -> becomes a plain note and **positions are dropped**
   *   - filehash + positions + text -> sticky_note
   *   - filehash + positions, no text -> highlight
   * so a highlight must be sent without `text`.
   */
  async createAnnotation(body: {
    document_id: string
    filehash: string
    type: 'highlight' | 'sticky_note'
    positions: { top_left: { x: number; y: number }; bottom_right: { x: number; y: number }; page: number }[]
    text?: string
    privacy_level?: string
  }): Promise<CloudAnnotation> {
    return this.request<CloudAnnotation>('POST', '/annotations', {
      body: { privacy_level: 'private', ...body },
      contentType: CT_ANNOTATION
    })
  }

  async deleteAnnotation(id: string): Promise<void> {
    await this.request('DELETE', '/annotations/' + id, { contentType: CT_ANNOTATION })
  }

  /** filehash of a document's attached file; highlights cannot be created
   *  without it.  It is the SHA-1 of the PDF bytes, so a local copy can stand
   *  in if the API ever stops returning it. */
  async fileHash(documentId: string): Promise<string | null> {
    const files = await this.request<{ filehash?: string }[]>('GET', '/files', {
      params: { document_id: documentId, limit: '10' }
    })
    return files?.[0]?.filehash ?? null
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
  /** Permanent delete.  DELETE /documents/{id} 404s for a trashed document;
   *  /trash/{id} is the only thing that actually removes it. */
  async purgeDocument(id: string): Promise<void> {
    await this.request('DELETE', '/trash/' + id)
  }

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
