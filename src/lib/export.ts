import type { Annotation, Doc } from '../../shared/types'
import { bibtexType, hasJournalField, risType } from './exportTypes'
import { citationKeyStem } from './citeKey'

/** EndNote ref-type name and its numeric code, which the desktop importer
 *  still relies on.  The names are the ones import.ts maps back from, so a
 *  file exported here round-trips through the importer unchanged. */
const EN_TYPE: Record<string, [string, number]> = {
  journal: ['Journal Article', 17],
  conference_proceedings: ['Conference Proceedings', 47],
  book: ['Book', 6],
  book_section: ['Book Section', 5],
  thesis: ['Thesis', 32],
  report: ['Report', 30],
  working_paper: ['Working Paper', 34],
  web_page: ['Web Page', 12],
  patent: ['Patent', 25],
  magazine_article: ['Magazine Article', 28],
  newspaper_article: ['Newspaper Article', 21],
  computer_program: ['Computer Program', 3],
  generic: ['Generic', 0]
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** BibTeX values are wrapped in braces, so an unmatched brace in a title used
 *  to end the whole record early and silently drop the author, year and DOI.
 *  Escape the three characters that change the parse; import.ts's parser
 *  skips escaped braces when it counts depth, and untex() puts the character
 *  back. A newline inside a field becomes a space. */
const escBib = (s: string) =>
  String(s ?? '')
    .replace(/\r?\n\s*/g, ' ')
    .replace(/([\\{}])/g, '\\$1')

/** RIS is line oriented: every line must start with a two-letter tag. A
 *  newline in a value produced an untagged line that the importer skipped. */
const escRis = (s: string) => String(s ?? '').replace(/\r?\n\s*/g, ' ')

const el = (name: string, v?: string | number | null): string =>
  v === undefined || v === null || String(v) === ''
    ? ''
    : `<${name}>${esc(String(v))}</${name}>`

/** BibTeX and EndNote both need a key when the paper has no citation_key.
 *  The stem is shared with the `\cite{...}` a reader copies; only the
 *  disambiguation letter belongs to a whole-file export. */
function surnameKey(d: Doc, i: number): string {
  return (
    citationKeyStem(d.authors?.[0]?.last_name ?? '', d.year) +
    String.fromCharCode(97 + (i % 26))
  )
}

function authorsFlat(d: Doc): string {
  return (d.authors ?? [])
    .map((a) => [a.first_name, a.last_name].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' and ')
}

/** BibTeX.  A citation_key the user already set is honoured; otherwise we
 *  synthesise one rather than emitting an entry with no key. */
export function toBibtex(docs: Doc[]): string {
  return docs
    .map((d, i) => {
      const key = escBib((d.citation_key || '').trim() || surnameKey(d, i))
      const lines = [
        `  title     = {${escBib(d.title ?? '')}}`,
        `  author    = {${escBib(authorsFlat(d))}}`,
        `  year      = {${escBib(String(d.year ?? ''))}}`
      ]
      if (d.source) {
        const f = hasJournalField(d) ? 'journal' : 'booktitle'
        lines.push(`  ${f}      = {${escBib(d.source)}}`)
      }
      if (d.doi) lines.push(`  doi       = {${escBib(d.doi)}}`)
      if (d.arxiv) lines.push(`  eprint    = {${escBib(d.arxiv)}}`)
      if (d.pages) lines.push(`  pages     = {${escBib(d.pages)}}`)
      if (d.volume) lines.push(`  volume    = {${escBib(d.volume)}}`)
      if (d.publisher) lines.push(`  publisher = {${escBib(d.publisher)}}`)
      if (d.url) lines.push(`  url       = {${escBib(d.url)}}`)
      return `@${bibtexType(d)}{${key},\n${lines.join(',\n')}\n}`
    })
    .join('\n\n')
}

const authorsLine = (d: Doc): string =>
  (d.authors ?? [])
    .map((a) => [a.first_name, a.last_name].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('; ')

/**
 * The notes, as Markdown.
 *
 * This is the only data in the app that exists nowhere else.  Mendeley has no
 * /notes endpoint, so a note written here lives in one JSON file on one
 * machine, and the three bibliography exporters never see it: they take
 * `Doc[]` and a `Doc` has no note on it.  Losing the cache costs a resync and
 * losing a PDF costs a download; losing this costs the reading, which is the
 * one thing that cannot be fetched again.
 *
 * Markdown rather than a fourth bibliography format because nothing imports
 * notes — they get read, pasted into a manuscript, or grepped.  Text that
 * survives being opened in anything is the whole point.
 */
export function toNotesMarkdown(docs: Doc[], notes: Record<string, string>): string {
  const kept = docs.filter((d) => (notes[d.id] ?? '').trim())
  const head = ['# 笔记导出', '', `${kept.length} 条 · ${new Date().toISOString().slice(0, 10)}`]
  const body = kept.map((d) => {
    const lines = [`## ${d.title ?? '(无标题)'}`, '']
    // enough to find the paper again in another program, and no more: this
    // file is for reading the notes, not for replacing the bibliography
    const meta: [string, string | undefined | null][] = [
      ['作者', authorsLine(d)],
      ['年份', d.year != null ? String(d.year) : ''],
      ['发表处', d.source],
      ['citation key', d.citation_key],
      ['DOI', d.identifiers?.doi ?? d.doi]
    ]
    for (const [k, v] of meta) if (v) lines.push(`- ${k}：${v}`)
    lines.push('', (notes[d.id] ?? '').trim())
    return lines.join('\n')
  })
  return head.join('\n') + '\n\n' + body.join('\n\n---\n\n')
}

/**
 * The annotations, as Markdown.
 *
 * A highlight is the second kind of data here with no other copy.  Mendeley
 * keeps the rectangles, so the marks themselves survive a resync, but it does
 * not keep the words underneath them — and the words are what the reader
 * marked them for.  The three bibliography exporters take `Doc[]` and never
 * see an annotation, so until now they could not leave the app either.
 *
 * Markdown, for the same reason as the notes: nobody imports highlights.  They
 * get read, pasted into a manuscript, or grepped.  Page order rather than the
 * order they were made in, because this file gets read rather than audited.
 *
 * `library`, when given, is the whole library rather than the selection.  It
 * is what tells "a paper outside the current filter" — which is simply not
 * exported — from "a paper that is no longer in the library at all", whose
 * annotations have no other way out and which therefore come last, together.
 */
export function toAnnotationsMarkdown(
  docs: Doc[],
  anns: Annotation[],
  library?: Doc[]
): string {
  const known = new Set((library ?? docs).map((d) => d.id))
  const byDoc = new Map<string, Annotation[]>()
  const lost: Annotation[] = []
  for (const a of anns) {
    if (!known.has(a.docId)) {
      lost.push(a)
      continue
    }
    const g = byDoc.get(a.docId)
    if (g) g.push(a)
    else byDoc.set(a.docId, [a])
  }

  /** Reading order: page, then down the page, remembering PDF y counts up. */
  const inOrder = (list: Annotation[]) =>
    [...list].sort((x, y) => {
      const px = x.pos?.[0]?.page ?? x.page ?? 0
      const py = y.pos?.[0]?.page ?? y.page ?? 0
      if (px !== py) return px - py
      const yx = x.pos?.[0]?.y ?? 0
      const yy = y.pos?.[0]?.y ?? 0
      if (yx !== yy) return yy - yx
      return String(x.created ?? '').localeCompare(String(y.created ?? ''))
    })

  const section = (title: string, d: Doc | undefined, list: Annotation[]): string => {
    const lines = [`## ${title}`, '']
    if (d) {
      const meta: [string, string | undefined | null][] = [
        ['作者', authorsLine(d)],
        ['年份', d.year != null ? String(d.year) : ''],
        ['发表处', d.source],
        ['citation key', d.citation_key],
        ['DOI', d.identifiers?.doi ?? d.doi]
      ]
      for (const [k, v] of meta) if (v) lines.push(`- ${k}：${v}`)
      lines.push('')
    }
    for (const a of inOrder(list)) {
      const on = a.pos?.[0]?.page ?? a.page ?? 0
      const said = (a.text ?? '').replace(/\s+/g, ' ').trim()
      // Mendeley sends a note back as the only text it has, so for anything
      // that came from the cloud the two are the same sentence; printing it
      // twice would make every cloud highlight read twice
      const mine = (a.note ?? '').trim()
      const own = mine && mine !== said ? mine : ''
      const tags = [a.type === 'note' ? '笔记' : '', own].filter(Boolean)
      lines.push('> ' + (said || own || '（没有记录到文字）'))
      lines.push('>')
      lines.push(`> — p${on}${tags.length ? ' · ' + tags.join(' · ') : ''}`)
      lines.push('')
    }
    return lines.join('\n')
  }

  const parts = docs
    .filter((d) => byDoc.has(d.id))
    .map((d) => section(d.title ?? '(无标题)', d, byDoc.get(d.id) ?? []))
  if (lost.length) parts.push(section('（已不在库中）', undefined, lost))

  const head = [
    '# 标注导出',
    '',
    `${anns.length} 条 · ${parts.length} 篇 · ${new Date().toISOString().slice(0, 10)}`
  ]
  return head.join('\n') + '\n\n' + parts.join('\n---\n\n')
}

/**
 * The note left on the doorstep of a folder holding the whole library.
 *
 * "Export" in most programs means "here is a file, good luck".  A reader who
 * is leaving wants the opposite: to be told what they are holding, what it
 * opens in, and what of it cannot be imported anywhere.  Saying the last part
 * out loud is the point — notes and highlights have no import format, and a
 * folder that pretends otherwise would have the reader discovering it after
 * the old library was gone.
 */
export function toExitReadme(c: {
  docs: number
  notes: number
  anns: number
  pdfs: number
}): string {
  const when = new Date().toISOString().slice(0, 10)
  const held = [
    `${c.docs} 篇文献`,
    c.notes ? `${c.notes} 条笔记` : '',
    c.anns ? `${c.anns} 条标注` : '',
    c.pdfs ? `${c.pdfs} 份 PDF` : ''
  ].filter(Boolean)
  const lines = [
    `Mendeley NG 导出 · ${when}`,
    '',
    `这个文件夹里是：${held.join('、')}。`,
    '',
    '  library.bib           BibTeX，Zotero / JabRef / LaTeX 都能读',
    '  library.ris           RIS，EndNote / Papers 一类',
    '  library.endnote.xml   EndNote XML',
    c.notes ? '  notes.md              写在每一篇上的笔记' : '',
    c.anns ? '  annotations.md        高亮与批注，按篇分组，带页码和被划的那句话' : '',
    c.pdfs ? '  pdf/                  PDF 原件，文件名是它在本地原来的名字' : '',
    '',
    '怎么拿回去：在要去的地方 import library.bib（或 .ris / .xml），书目就回来了。',
    c.pdfs
      ? '  PDF 是原文件本身，不需要导入；要重新挂回条目，按文件名在 pdf/ 里找。'
      : '  这次没有复制 PDF——它们是你在设置里选的那个目录里的原文件，本来就在你手上。'
  ]
  if (c.notes || c.anns) {
    lines.push(
      '',
      '两件没有导入格式的事，先说清楚：',
      '  笔记和标注没有通用格式，哪个工具都不 import 它们。它们是给你读、粘进稿子、',
      '  或者 grep 的——按篇写好了，翻到哪篇都能对上。'
    )
  }
  lines.push('', '这次导出没有改动库里的任何东西，也没有联网。')
  return lines.filter((l) => l !== '').join('\n') + '\n'
}

/** A number of bytes as a reader would say it.  Shared with the confirm box,
 *  which has to state what copying the PDFs will cost before doing it. */
export function humanBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  return `${Math.max(1, Math.round(n / 1e3))} KB`
}

export function toRis(docs: Doc[]): string {
  return docs
    .map((d) => {
      const out: string[] = ['TY  - ' + risType(d)]
      if (d.title) out.push('TI  - ' + escRis(d.title))
      if (d.abstract) out.push('AB  - ' + escRis(d.abstract))
      for (const a of d.authors ?? []) {
        const n = [a.last_name, a.first_name].filter(Boolean).join(', ')
        if (n) out.push('AU  - ' + escRis(n))
      }
      if (d.year) out.push('PY  - ' + escRis(String(d.year)))
      if (d.source) {
        out.push((hasJournalField(d) ? 'JO  - ' : 'T2  - ') + escRis(d.source))
      }
      if (d.doi) out.push('DO  - ' + escRis(d.doi))
      if (d.pages) out.push('SP  - ' + escRis(d.pages))
      if (d.volume) out.push('VL  - ' + escRis(d.volume))
      if (d.issue) out.push('IS  - ' + escRis(d.issue))
      if (d.publisher) out.push('PB  - ' + escRis(d.publisher))
      if (d.url) out.push('UR  - ' + escRis(d.url))
      if (d.citation_key) out.push('ID  - ' + escRis(d.citation_key))
      out.push('ER  - ')
      return out.join('\n')
    })
    .join('\n\n')
}

/**
 * EndNote XML.  EndNote's own exporter is the reference here, including the
 * habit of putting one identifier in `electronic-resource-num`, which is the
 * DOI when there is one and the ISBN otherwise — the importer tells them
 * apart by the `10.` prefix.
 */
export function toEndnoteXml(docs: Doc[]): string {
  const records = docs
    .map((d, i) => {
      const [name, code] = EN_TYPE[d.type ?? ''] ?? EN_TYPE.generic
      // only a DOI or an ISBN: the importer reads this one field and tells
      // them apart by the "10." prefix, so an arXiv id here would be imported
      // back as a bogus ISBN
      const ern = d.identifiers?.doi ?? d.doi ?? d.identifiers?.isbn
      const lines = [
        `<ref-type name="${name}">${code}</ref-type>`,
        '<contributors>',
        '<authors>',
        ...(d.authors ?? []).map((a) =>
          el('author', [a.last_name, a.first_name].filter(Boolean).join(', '))
        ),
        '</authors>',
        '</contributors>',
        '<titles>',
        el('title', d.title),
        el('secondary-title', d.source),
        '</titles>',
        el('pages', d.pages),
        el('volume', d.volume),
        el('number', d.issue),
        d.year ? `<dates><year>${d.year}</year></dates>` : '',
        el('publisher', d.publisher),
        el('abstract', d.abstract),
        el('electronic-resource-num', ern),
        d.url ? `<urls><related-urls><url>${esc(d.url)}</url></related-urls></urls>` : '',
        d.keywords?.length
          ? `<keywords>${d.keywords.map((k) => el('keyword', k)).join('')}</keywords>`
          : '',
        // EndNote matches records on this, so an entry without a citation key
        // still needs one or the import silently drops it
        el('ref-id', (d.citation_key || '').trim() || surnameKey(d, i))
      ].filter(Boolean)
      return `  <record>\n${lines.map((l) => '    ' + l).join('\n')}\n  </record>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xml>\n<records>\n${records}\n</records>\n</xml>\n`
}
