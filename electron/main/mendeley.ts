import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { CloudAnnotation, Doc, Folder } from '../../shared/types'
import { collectFileDocumentIds, type FilePageRow } from '../../shared/filePages'
import { collectPaged } from '../../shared/paged'
import { UA } from '../../shared/userAgent'

const BASE = 'https://api.mendeley.com'
const TOKEN_URL = BASE + '/oauth/token'

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

export interface Token {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  client_id?: string
  client_secret?: string
  _expires_at?: number
}

/** A minute of slack, so no request starts with a token that is about to
 *  expire.  One rule for construction, refresh, save and import: the same
 *  expression used to be copied into four places. */
function expiryFromNow(tok: Token): number {
  return Date.now() / 1000 + (tok.expires_in ?? 3600) - 60
}

export class Mendeley {
  private tok: Token
  private tokenPath: string

  constructor(tokenPath: string, tok: Token) {
    this.tokenPath = tokenPath
    this.tok = tok
    if (!this.tok._expires_at) this.tok._expires_at = expiryFromNow(this.tok)
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

  private refreshPromise: Promise<void> | null = null

  /** Concurrent callers share one refresh.  Without this, several requests
   *  that all see an expired token start separate refreshes, and the second
   *  `this.tok` assignment and `save()` can overwrite the first. */
  private refresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = null
      })
    }
    return this.refreshPromise
  }

  private async doRefresh() {
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
    this.tok._expires_at = expiryFromNow(fresh)
    this.save()
  }

  /** One freshness check and one header shape for every authenticated call,
   *  including the two that carry raw bytes instead of JSON. */
  private async ensureFresh(): Promise<void> {
    if ((this.tok._expires_at ?? 0) < Date.now() / 1000) await this.refresh()
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: 'Bearer ' + this.tok.access_token,
      'User-Agent': UA,
      Accept: '*/*'
    }
  }

  /** Send once, and once more after a refresh if the token was rejected.
   *
   *  The JSON, download and upload paths each used to hand-roll this retry;
   *  the two raw-byte ones never went through request() at all and so could
   *  drift in both their error format and their retry behaviour. */
  private async send(
    url: string,
    build: (headers: Record<string, string>) => RequestInit
  ): Promise<Response> {
    await this.ensureFresh()
    let res = await fetch(url, build(this.authHeaders()))
    if (res.status === 401) {
      await this.refresh()
      res = await fetch(url, build(this.authHeaders()))
    }
    return res
  }

  /** A bearer token for callers that talk to Mendeley without going through
   *  `request`, which is what the catalogue lookup in lookup.ts does.  GET
   *  /catalog answers 401 "No auth header" anonymously, so it cannot be used
   *  without this. */
  async bearer(): Promise<string> {
    await this.ensureFresh()
    return this.tok.access_token
  }

  async request<T = unknown>(
    method: string,
    p: string,
    opts: {
      params?: Record<string, string>
      body?: unknown
      contentType?: string
    } = {}
  ): Promise<T> {
    let url = BASE + p
    if (opts.params) {
      url += '?' + new URLSearchParams(opts.params).toString()
    }
    const res = await this.send(url, (headers) => {
      const h = { ...headers }
      let payload: string | undefined
      if (opts.body !== undefined) {
        h['Content-Type'] = opts.contentType ?? CT_DOC
        payload = JSON.stringify(opts.body)
      }
      return { method, headers: h, body: payload }
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`${method} ${p} -> ${res.status} ${txt.slice(0, 300)}`)
    }
    if (res.status === 204) return undefined as T
    const txt = await res.text()
    return (txt.trim() ? JSON.parse(txt) : undefined) as T
  }

  /** Full or incremental pull.  `view=all` is mandatory: the default view
   *  omits citation_key, file_attached and folder_uuids.  `since` is an
   *  ISO timestamp and really does filter — verified against the live API,
   *  where "now" returns nothing and "an hour ago" returns the one document
   *  touched in that window. */
  async allDocuments(onPage?: (n: number) => void, since?: string): Promise<Doc[]> {
    const base: Record<string, string> = { limit: '100', view: 'all' }
    if (since) base.modified_since = since
    return collectPaged<Doc>(
      (marker) =>
        this.request<Doc[]>('GET', '/documents', {
          params: marker ? { ...base, marker } : base
        }),
      100,
      200,
      onPage
    )
  }

  async allFolders(): Promise<Folder[]> {
    return collectPaged<Folder>(
      (marker) =>
        this.request<Folder[]>('GET', '/folders', {
          params: marker ? { limit: '200', marker } : { limit: '200' }
        }),
      200,
      20
    )
  }

  /** Document ids that actually carry a file.  file_attached lies often
   *  enough to be worth cross-checking against this. The paging rule lives in
   *  shared/filePages.ts: the marker is the file id, and a duplicate page ends
   *  the walk instead of being requested two hundred times. */
  async fileDocumentIds(): Promise<Set<string>> {
    return collectFileDocumentIds((marker) =>
      this.request<FilePageRow[]>('GET', '/files', {
        params: marker ? { limit: '200', marker } : { limit: '200' }
      })
    )
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
    let res = await this.send(`${BASE}/files/${fileId}`, (headers) => ({
      headers,
      redirect: 'manual'
    }))
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
    const res = await this.send(`${BASE}/documents`, (headers) => ({
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/pdf',
        // the server parses the file name out of this header
        'Content-Disposition': `attachment; filename="${fileName.replace(/["\r\n]/g, '')}"`
      },
      body: data
    }))
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
    const base: Record<string, string> = { document_id: documentId, limit: '200' }
    return collectPaged<CloudAnnotation>(
      (marker) =>
        this.request<CloudAnnotation[]>('GET', '/annotations', {
          params: marker ? { ...base, marker } : base
        }),
      200,
      50
    )
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
    const base: Record<string, string> = { limit: '100', view: 'all' }
    return collectPaged<Doc>(
      (marker) =>
        this.request<Doc[]>('GET', '/trash', {
          params: marker ? { ...base, marker } : base
        }),
      100,
      100
    )
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

/** The one authoritative destination for credentials.
 *
 *  findToken, saveToken and importTokenFrom used to disagree about it: with
 *  MENDELEY_TOKEN_PATH set, a fresh authorization was written to the override
 *  while the next launch still returned the older userData token first, so
 *  the new token never took effect and nothing said why.  The override is now
 *  both the first place looked and the only place written. */
export function tokenDest(): string {
  return process.env.MENDELEY_TOKEN_PATH ||
    path.join(app.getPath('userData'), 'token.json')
}

/** Look for an existing token in the obvious places, so the app can reuse the
 *  credentials the CLI scripts already produced instead of asking the user to
 *  authorise again. */
export function findToken(): { path: string; tok: Token } | null {
  const candidates = [
    tokenDest(),
    path.join(app.getPath('userData'), 'token.json'),
    path.join(app.getPath('userData'), 'mendeley-token.json')
  ]
  // the override and the default can be the same path; only read it once
  for (const c of new Set(candidates)) {
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

/**
 * Swap an authorization code for a token.
 *
 * This lives here rather than in auth.ts because the Cloudflare rule is the
 * same one every request in this file obeys: /oauth/token answers 1010 to
 * anything without a browser User-Agent, so the header cannot be an
 * afterthought in one of the two places that call it.
 */
export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<Token> {
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
      redirect_uri: redirectUri
    }).toString()
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`换 token 失败：${res.status} ${text.slice(0, 200)}`)
  }
  const tok = JSON.parse(text) as Token
  // kept next to the token because refreshing needs them: a client_secret
  // that was never written down is a re-authorisation a year later
  tok.client_id = clientId
  tok.client_secret = clientSecret
  return tok
}

/** Credentials stay a plain write rather than the shared tmp+rename helper on
 *  purpose: renaming replaces the inode and would discard the file permissions
 *  and the plaintext temp file that this path is deliberately careful about. */
function writeToken(dest: string, tok: Token): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  tok._expires_at = expiryFromNow(tok)
  fs.writeFileSync(dest, JSON.stringify(tok, null, 2), 'utf-8')
}

/** Write a token where the app will look for it on the next launch. */
export function saveToken(tok: Token): string {
  const dest = tokenDest()
  writeToken(dest, tok)
  return dest
}

export function importTokenFrom(src: string): { path: string; tok: Token } {
  const tok = JSON.parse(fs.readFileSync(src, 'utf-8')) as Token
  if (!tok.access_token) throw new Error('token file has no access_token')
  const dest = tokenDest()
  writeToken(dest, tok)
  return { path: dest, tok }
}
