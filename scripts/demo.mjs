/**
 * Write a throwaway library of invented papers and screenshot the app on it.
 *
 * The README needs pictures, and the obvious way to get them — point the app
 * at the real library and press PrtSc — puts somebody's actual reading list,
 * their note text and their file paths into a public repository.  So the
 * screenshots are taken against a library that does not exist: made-up titles,
 * made-up authors, and PDFs generated here out of thin air.
 *
 * Nothing of the user's is read and nothing of theirs is written.  The app
 * runs with `--user-data-dir` pointed at `.demo/`, which this script owns, so
 * its cache, its config and its full-text index all land there.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const demoDir = path.join(root, '.demo')
const libDir = path.join(demoDir, 'library')
const pdfDir = path.join(demoDir, 'pdfs')
const outDir = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : path.join(root, 'docs', 'screenshots')

/* ------------------------------------------------------------------ PDF ---- */

const PAGE_W = 595
const PAGE_H = 842
const LEFT = 64
const RIGHT = 64
const TOP = 780

/** Rough advance width for Helvetica, in em.  Good enough to wrap a line
 *  without running off the page; a real metric table would buy nothing here. */
const AVG = 0.5

function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function wrap(text, size) {
  const room = PAGE_W - LEFT - RIGHT
  const per = Math.max(8, Math.floor(room / (size * AVG)))
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const w of words) {
    const next = line ? line + ' ' + w : w
    if (next.length > per && line) {
      lines.push(line)
      line = w
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Lay out blocks into pages.
 *
 * Returns the content streams and, for every line, where it landed.  The
 * geometry is what lets the script place its two seeded highlights on the
 * lines they claim to mark: a rect guessed at by eye lands on the wrong line,
 * and a screenshot of a highlight over blank paper is worse than none.
 * `y` stays measured from the bottom, the way PDF text is positioned; the
 * rects the app wants are 0..1 from the top.
 */
function layout(blocks) {
  const pages = []
  const lines = []
  let ops = []
  let y = TOP
  let page = 0
  const flush = () => {
    if (ops.length) pages.push(ops.join('\n'))
    ops = []
    y = TOP
    page += 1
  }
  for (const b of blocks) {
    const size = b.size ?? 10
    const font = b.font ?? 'F1'
    const indent = b.indent ?? 0
    for (const line of wrap(b.text, size)) {
      const lead = size * 1.35
      if (y - lead < 56) flush()
      y -= lead
      ops.push(`BT /${font} ${size} Tf ${LEFT + indent} ${y.toFixed(2)} Td (${esc(line)}) Tj ET`)
      lines.push({
        page: page + 1,
        text: line,
        x: LEFT + indent,
        base: y,
        size,
        width: Math.min(line.length * size * AVG, PAGE_W - LEFT - indent - RIGHT)
      })
    }
    y -= b.gap ?? size * 0.4
  }
  flush()
  return { pages, lines }
}

/** The rect the app stores: 0..1, y from the top. */
function rectOf(line) {
  return {
    x: +(line.x / PAGE_W).toFixed(4),
    y: +((PAGE_H - (line.base + line.size * 0.75)) / PAGE_H).toFixed(4),
    w: +(line.width / PAGE_W).toFixed(4),
    h: +((line.size * 1.05) / PAGE_H).toFixed(4)
  }
}

function buildPdf(pages) {
  const heads = []
  let body = '%PDF-1.7\n'
  const add = (id, text) => {
    heads.push(body.length)
    body += `${id} 0 obj\n${text}\nendobj\n`
  }
  const fontIds = [3, 4, 5]
  const pageIds = []
  let next = 6
  for (let i = 0; i < pages.length; i++) {
    pageIds.push([next, next + 1])
    next += 2
  }
  add(1, '<< /Type /Catalog /Pages 2 0 R >>')
  add(2, `<< /Type /Pages /Kids [${pageIds.map((p) => `${p[0]} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  add(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  add(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  add(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>')
  pages.forEach((content, i) => {
    const [pid, cid] = pageIds[i]
    add(
      pid,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        '/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> ' +
        `/Contents ${cid} 0 R >>`
    )
    add(cid, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`)
  })
  const start = body.length
  const n = next
  let xref = `xref\n0 ${n}\n0000000000 65535 f \n`
  for (let i = 1; i < n; i++) {
    // ids are allocated in the same order the objects were written, so the
    // offset of object i is the i-th one recorded
    xref += `${String(heads[i - 1] ?? 0).padStart(10, '0')} 00000 n \n`
  }
  body += xref
  body += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

/* ----------------------------------------------------------------- data ---- */

const VENUES = [
  'Journal of Imaginary Results',
  'Transactions on Placeholder Methods',
  'Proceedings of the Workshop on Synthetic Benchmarks',
  'Reviews of Hypothetical Systems',
  'Letters on Contrived Examples'
]

// Invented end to end.  The DOIs use the 10.5555 prefix that is reserved for
// examples, so nothing here resolves to a real paper by accident.
const PAPERS = [
  ['Retrieval That Admits When It Is Guessing', ['A. Larkspur', 'M. Okonkwo', 'B. Fen'], 2023, 'Benchmarks'],
  ['A Small Study of Very Large Tables', ['P. Vermeer', 'S. Haddad'], 2022, 'Benchmarks'],
  ['Notes on Reading the Same Paragraph Twice', ['K. Adeyemi', 'R. Lindqvist', 'T. Nakamura'], 2024, 'Writing'],
  ['How Much Context Is Too Much Context', ['M. Okonkwo', 'D. Ferraro'], 2024, 'Reading queue'],
  ['Spacing Out: Margins and Reading Speed', ['B. Fen', 'A. Larkspur'], 2021, 'Reading queue'],
  ['Citations That Point Nowhere', ['S. Haddad', 'K. Adeyemi'], 2023, 'Writing'],
  ['On the Care and Feeding of a Reference List', ['R. Lindqvist'], 2020, 'Writing'],
  ['Duplicate Detection for People Who Hoard PDFs', ['T. Nakamura', 'P. Vermeer'], 2024, 'Benchmarks'],
  ['An Annotated Bibliography of Nothing in Particular', ['D. Ferraro', 'M. Okonkwo', 'S. Haddad'], 2022, 'Archive'],
  ['The Cost of Re-reading the Abstract', ['A. Larkspur', 'K. Adeyemi'], 2023, 'Reading queue'],
  ['Sorting a Library by Colour', ['B. Fen', 'R. Lindqvist'], 2019, 'Archive'],
  ['Why the Second Edition Is Never Free', ['P. Vermeer'], 2021, 'Archive'],
  ['A Field Guide to Half-Remembered Papers', ['M. Okonkwo', 'T. Nakamura'], 2024, 'Reading queue'],
  ['Indexing Without Reading', ['S. Haddad', 'D. Ferraro', 'B. Fen'], 2022, 'Benchmarks'],
  ['The Reference You Were Thinking Of Does Not Exist', ['K. Adeyemi', 'A. Larkspur'], 2023, 'Writing'],
  ['Folders, Tags, and the Space Between', ['R. Lindqvist', 'P. Vermeer'], 2020, 'Archive'],
  ['Reading Lists as a Form of Procrastination', ['T. Nakamura'], 2024, 'Reading queue'],
  ['Two Papers, One DOI', ['D. Ferraro', 'K. Adeyemi'], 2021, 'Archive']
]

const ABSTRACT =
  'This note describes a small experiment run entirely on synthetic material, ' +
  'which is the only kind of material that can be published without worrying ' +
  'about whether the numbers were ever true. We report, at length, on a method ' +
  'that retrieves paragraphs from documents and then declines to say anything ' +
  'about them. The retrieval stage is standard; the declining stage is the ' +
  'contribution. Readers who were expecting a comparison against a strong ' +
  'baseline will not find one here, because no strong baseline was consulted.'

const BODY =
  'The rest of this document exists so that the reader pane has something to ' +
  'render. It mentions retrieval, indexing, annotation and highlighting several ' +
  'times, which is enough for a full-text search to have something to find. ' +
  'Every sentence is filler and none of it means anything.'

function paperPdf(title, authors, year, venue) {
  const blocks = [
    { text: title, size: 17, font: 'F2', gap: 6 },
    { text: authors.join(', '), size: 10, font: 'F3', gap: 14 },
    { text: `${venue}, ${year}`, size: 9, font: 'F3', gap: 20 },
    { text: 'Abstract', size: 12, font: 'F2', gap: 4 },
    { text: ABSTRACT, size: 10, indent: 18, gap: 14 },
    { text: '1  Introduction', size: 12, font: 'F2', gap: 4 },
    { text: BODY, size: 10, gap: 8 },
    { text: BODY, size: 10, gap: 14 },
    { text: '2  Method', size: 12, font: 'F2', gap: 4 },
    { text: BODY, size: 10, gap: 8 },
    { text: BODY, size: 10, gap: 14 },
    { text: '3  Results', size: 12, font: 'F2', gap: 4 },
    { text: BODY, size: 10, gap: 8 },
    { text: BODY, size: 10, gap: 14 },
    { text: 'References', size: 12, font: 'F2', gap: 4 },
    { text: '[1] A. Larkspur and M. Okonkwo. Retrieval that admits when it is guessing. ' + VENUES[0] + ', 2023.', size: 9, gap: 2 },
    { text: '[2] P. Vermeer. A small study of very large tables. ' + VENUES[1] + ', 2022.', size: 9, gap: 2 },
    { text: '[3] K. Adeyemi et al. Notes on reading the same paragraph twice. ' + VENUES[2] + ', 2024.', size: 9, gap: 0 }
  ]
  const { pages, lines } = layout(blocks)
  const buf = buildPdf(pages)
  const find = (re) => lines.find((l) => re.test(l.text))
  const marks = [
    { re: /^This note describes/, color: 'yellow' },
    { re: /^1 Introduction/, color: 'green' }
  ]
    .map((m) => {
      const line = find(m.re)
      return line ? { ...m, page: line.page, rect: rectOf(line), text: line.text } : null
    })
    .filter(Boolean)
  return { buf, marks }
}

const folders = [
  { id: 'f-read', name: 'Reading queue', parent_id: null },
  { id: 'f-write', name: 'Writing', parent_id: null },
  { id: 'f-bench', name: 'Benchmarks', parent_id: null },
  { id: 'f-archive', name: 'Archive', parent_id: null },
  { id: 'f-child', name: 'Last year', parent_id: 'f-archive' }
]

const byName = new Map(folders.map((f) => [f.name, f.id]))

// before anything is written: the PDFs are produced while the document list
// is built, so the directories have to exist by then
fs.rmSync(demoDir, { recursive: true, force: true })
fs.mkdirSync(libDir, { recursive: true })
fs.mkdirSync(pdfDir, { recursive: true })

const marks = []

const docs = PAPERS.map((p, i) => {
  const [title, authors, year, folder] = p
  const id = 'demo-' + String(i + 1).padStart(3, '0')
  const venue = VENUES[i % VENUES.length]
  const hasPdf = i % 3 !== 1
  const pdf = hasPdf ? path.join(pdfDir, `demo-${String(i + 1).padStart(3, '0')}.pdf`) : undefined
  const made = hasPdf ? paperPdf(title, authors, year, venue) : null
  if (made) {
    fs.writeFileSync(pdf, made.buf)
    if (made.marks.length) marks.push({ id, marks: made.marks })
  }
  return {
    id,
    title,
    authors: authors.map((a) => {
      const [first, last] = a.split(' ')
      return { first_name: first, last_name: last }
    }),
    year,
    source: venue,
    abstract: ABSTRACT,
    identifiers: { doi: `10.5555/demo.${year}.${String(i + 1).padStart(3, '0')}` },
    citation_key: `demo${year}${String.fromCharCode(97 + (i % 26))}`,
    type: i % 4 === 0 ? 'journal' : 'conference_proceedings',
    folder_uuids: [byName.get(folder), i % 5 === 0 ? byName.get('Writing') : null].filter(Boolean),
    file_attached: hasPdf,
    localPdf: pdf,
    pages: '12',
    volume: String(1 + (i % 9)),
    issue: String(1 + (i % 4)),
    publisher: 'Society for Synthetic Results',
    keywords: ['synthetic', i % 2 ? 'retrieval' : 'annotation'],
    tags: i % 3 === 0 ? ['to read'] : i % 3 === 1 ? ['method'] : [],
    starred: i % 4 === 0,
    read: i % 3 !== 2,
    created: `2024-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}T09:00:00.000Z`,
    last_modified: `2024-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}T09:00:00.000Z`
  }
})

// Two highlights, placed on the lines they quote by the same layout pass that
// put those lines on the page.  Only the first paper gets them, because the
// reader screenshot is taken on the first paper.
const annotations = (marks.find((m) => m.id === 'demo-001')?.marks ?? []).map((m, i) => ({
  id: 'demo-ann-' + (i + 1),
  docId: 'demo-001',
  page: m.page,
  type: 'highlight',
  color: m.color,
  rects: [m.rect],
  text: m.text,
  created: '2024-05-0' + (i + 1) + 'T09:00:00.000Z'
}))
console.log('[demo] seeded highlights', annotations.length)

/* ------------------------------------------------------------------ run ---- */

fs.mkdirSync(outDir, { recursive: true })

const written = docs.filter((d) => d.localPdf).length
fs.writeFileSync(
  path.join(libDir, 'library.json'),
  JSON.stringify({ docs, folders, syncedAt: '2024-12-01T09:00:00.000Z' })
)
fs.writeFileSync(path.join(libDir, 'annotations.json'), JSON.stringify(annotations))
fs.writeFileSync(
  path.join(libDir, 'notes.json'),
  JSON.stringify({
    // on the paper the details screenshot is taken on, so the note field has
    // something in it rather than its placeholder
    'demo-002': 'Worth re-reading before the writing retreat.'
  })
)
fs.writeFileSync(
  path.join(libDir, 'config.json'),
  JSON.stringify(
    {
      pdfDir,
      fontSize: 15,
      theme: 'dark',
      pdfContinuous: false,
      citeStyle: 'author-year',
      ftPages: 3,
      paneLeft: 260,
      paneRight: 46,
      savedSearches: [
        {
          id: 'demo-search',
          name: 'synthetic retrieval',
          query: 'retrieval',
          folderId: null,
          starred: false
        }
      ]
    },
    null,
    2
  )
)
console.log('[demo] library', docs.length, 'docs', folders.length, 'folders', written, 'pdfs')

const bin =
  process.platform === 'win32'
    ? path.join(root, 'node_modules/electron/dist/electron.exe')
    : path.join(root, 'node_modules/electron/dist/electron')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
// the demo builds its own index, in its own directory, out of its own PDFs
env.MENDELEY_FT_DIR = path.join(demoDir, 'ft')
env.MENDELEY_DEMO_OUT = outDir

const child = spawn(
  bin,
  [root, '--demo', `--user-data-dir=${demoDir}`],
  { stdio: 'inherit', env, cwd: root }
)
child.on('close', (code) => process.exit(code ?? 0))
