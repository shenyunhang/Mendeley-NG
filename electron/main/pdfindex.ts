import fs from 'node:fs'
import path from 'node:path'
import type { Doc } from '../../shared/types'

/** Mendeley Desktop keeps every PDF flat in one folder, named
 *  "<authors> - <year> - [<something> - ]<title>.pdf".  Nothing in the file
 *  name references the document uuid, and the local database that would have
 *  the mapping is SQLCipher-encrypted, so the only way to attach a PDF to its
 *  record is to match on the title. */

const KEY = (s: string) =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 120)

export interface ParsedName {
  file: string
  full: string
  title: string
  year?: number
  authors?: string
}

export function parseName(name: string): ParsedName {
  const base = name.replace(/\.pdf$/i, '')
  const parts = base.split(' - ')
  // title is always the last segment; year is the second when it looks like one
  const title = parts[parts.length - 1] ?? base
  let year: number | undefined
  if (parts.length >= 2 && /^\d{4}$/.test(parts[1].trim())) {
    year = Number(parts[1].trim())
  }
  return { file: name, full: name, title, year, authors: parts[0] }
}

export interface MatchResult {
  matched: number
  total: number
  unmatchedFiles: string[]
}

/** Attach localPdf paths onto docs in place.  Two passes: exact
 *  (normalised title + year), then title-only for whatever is left, which
 *  rescues records whose year is missing or off by one. */
export function attachPdfs(docs: Doc[], pdfDir: string): MatchResult {
  if (!pdfDir || !fs.existsSync(pdfDir)) {
    return { matched: 0, total: 0, unmatchedFiles: [] }
  }
  const files = fs
    .readdirSync(pdfDir)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
  const parsed = files.map(parseName)

  const byTitleYear = new Map<string, string>()
  const byTitle = new Map<string, string>()
  for (const p of parsed) {
    const k = KEY(p.title)
    if (!k) continue
    if (p.year) {
      const key = k + '|' + p.year
      if (!byTitleYear.has(key)) byTitleYear.set(key, p.file)
    }
    if (!byTitle.has(k)) byTitle.set(k, p.file)
  }

  const used = new Set<string>()
  let matched = 0
  for (const d of docs) {
    const k = KEY(d.title ?? '')
    if (!k) continue
    let hit = d.year ? byTitleYear.get(k + '|' + d.year) : undefined
    if (!hit) hit = byTitle.get(k)
    if (hit) {
      d.localPdf = path.join(pdfDir, hit)
      used.add(hit)
      matched++
    }
  }
  // second chance for docs that are still without a file
  for (const d of docs) {
    if (d.localPdf) continue
    const k = KEY(d.title ?? '')
    const hit = byTitle.get(k)
    if (hit) {
      d.localPdf = path.join(pdfDir, hit)
      used.add(hit)
      matched++
    }
  }
  return {
    matched,
    total: files.length,
    unmatchedFiles: files.filter((f) => !used.has(f)).slice(0, 200)
  }
}
