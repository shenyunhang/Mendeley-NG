import { useMemo } from 'react'
import type { Annotation, Doc } from '../../../shared/types'
import {
  humanBytes,
  toAnnotationsMarkdown,
  toBibtex,
  toEndnoteXml,
  toExitReadme,
  toNotesMarkdown,
  toRis
} from '../export'

/**
 * Everything that writes the library out to a file or the clipboard: the
 * bibliography in three dialects, the notes, the highlights, and the one
 * action that gathers all of them into a folder to leave with.
 *
 * It reads the library and writes files; it changes nothing in the library.
 * That is the whole reason it can be a hook of its own — no `setLib`, no
 * undo stack, nothing that another part of the app is mid-way through
 * editing. It is handed the rows it acts on (`target`, the selection or the
 * whole view) and the four things it needs to read or report (`docs`,
 * `noteMap`, `anns`, and the two banners), and hands back the functions the
 * toolbar and the batch bar press.
 *
 * The functions are rebuilt on every render, exactly as they were when they
 * lived in `App`: they close over the `target` of that render, which is what
 * an export is supposed to act on.
 */
export function useExport({
  target,
  docs,
  noteMap,
  anns,
  setErr,
  setBatchMsg,
  askConfirm
}: {
  target: Doc[]
  docs: Doc[]
  noteMap: Record<string, string>
  anns: Annotation[]
  setErr: (m: string | null) => void
  setBatchMsg: (m: string | null) => void
  askConfirm: (req: {
    title: string
    body?: string
    ok?: string
    cancel?: string
  }) => Promise<boolean>
}) {
  /**
   * Exports ask where the file should go instead of dropping it in the
   * downloads folder, where a second export would quietly arrive as
   * "library (1).bib".  The folder is remembered on the far side, so the next
   * export starts where the last one ended.  Cancelling is silent: the reader
   * changed their mind, nothing went wrong.
   */
  const exportAs = async (fmt: 'bib' | 'ris' | 'xml') => {
    const kind = fmt === 'bib' ? 'BibTeX' : fmt === 'ris' ? 'RIS' : 'EndNote XML'
    const text =
      fmt === 'bib' ? toBibtex(target) : fmt === 'ris' ? toRis(target) : toEndnoteXml(target)
    const r = await window.api.saveText(`library.${fmt}`, text, kind, fmt)
    if (r.error) setErr(`导出失败：${r.error}`)
    else if (r.path) {
      setBatchMsg(`已导出 ${target.length} 条到 ${r.path}`)
      setTimeout(() => setBatchMsg(null), 6000)
    }
  }
  const exportBib = () => void exportAs('bib')
  const exportRis = () => void exportAs('ris')
  const exportEndnote = () => void exportAs('xml')

  /**
   * The notes, separately from the bibliography.
   *
   * They are the one thing in here with no other copy: Mendeley has no
   * endpoint for them, so they live in a local file the bibliography exporters
   * never read.  A library whose papers can all be exported but whose reading
   * cannot is not the library being in the reader's hands — the papers are
   * fetchable again and the reading is not.
   */
  const exportNotes = async () => {
    const withNotes = target.filter((d) => (noteMap[d.id] ?? '').trim())
    if (!withNotes.length) return
    const r = await window.api.saveText(
      'notes.md',
      toNotesMarkdown(withNotes, noteMap),
      '笔记（Markdown）',
      'md'
    )
    if (r.error) setErr(`导出失败：${r.error}`)
    else if (r.path) {
      setBatchMsg(`已导出 ${withNotes.length} 条笔记到 ${r.path}`)
      setTimeout(() => setBatchMsg(null), 6000)
    }
  }
  /** Whether there is anything to export, so the item can say so rather than
   *  writing an empty file.
   *
   *  Recomputed on every keystroke, because it depends on `target`.  Most
   *  libraries have no notes at all, and walking several thousand rows to
   *  decide whether one menu item is greyed out is not a thing to do once per
   *  character typed — so the empty case answers without looking at the list.
   */
  const canExportNotes = useMemo(() => {
    const ids = Object.keys(noteMap)
    if (!ids.length) return false
    const have = new Set(ids)
    return target.some((d) => have.has(d.id))
  }, [target, noteMap])

  /**
   * The highlights, separately from the bibliography and from the notes.
   *
   * Mendeley keeps the rectangles of a highlight but not the words under
   * them, and the words are the part that cannot be fetched again: the shape
   * of a mark on page seven is worthless on its own.  So this reads the store
   * again at the moment of exporting rather than trusting the copy held for
   * the menu — the reader writes annotations without passing them back.
   *
   * Annotations whose paper has since gone from the library come along:
   * nothing else can reach them, and they are the most exposed thing here.
   */
  const exportAnnotations = async () => {
    const all = await window.api.loadAnnotations()
    const pickedIds = new Set(target.map((d) => d.id))
    const allIds = new Set(docs.map((d) => d.id))
    const picked = all.filter((a) => pickedIds.has(a.docId) || !allIds.has(a.docId))
    if (!picked.length) return
    const r = await window.api.saveText(
      'annotations.md',
      toAnnotationsMarkdown(target, picked, docs),
      '标注（Markdown）',
      'md'
    )
    if (r.error) setErr(`导出失败：${r.error}`)
    else if (r.path) {
      setBatchMsg(`已导出 ${picked.length} 条标注到 ${r.path}`)
      setTimeout(() => setBatchMsg(null), 6000)
    }
  }
  /**
   * The way out, as one action.
   *
   * A program that lets you export four things one at a time has not really
   * answered "can I leave" — the reader has to know that those four things
   * exist, and that together they are everything.  So this writes all of them
   * into one folder with a note on top saying what is in it, including the two
   * parts no other program will import.
   *
   * The PDFs are the only part with a cost, so they are the only part asked
   * about, and the question carries the number: several thousand files can be
   * thirty gigabytes, and "do you want the PDFs too" without that figure is
   * not a question anybody can answer.
   */
  const leaveLibrary = async () => {
    if (!target.length) return
    const dir = await window.api.pickDir('把这一库放到哪个文件夹')
    // choosing nothing is the reader changing their mind, not a failure
    if (!dir) return
    const withPdf = target.filter((d) => d.localPdf).map((d) => d.localPdf!)
    const plan = withPdf.length ? await window.api.pdfPlan(withPdf) : { copies: [], bytes: 0 }
    let copies: { from: string; to: string }[] = []
    if (plan.copies.length) {
      const go = await askConfirm({
        title: 'PDF 也复制一份？',
        body:
          `${plan.copies.length} 个文件，${humanBytes(plan.bytes)}。\n\n` +
          '复制的是原件，库里那些不受影响。不复制也能走：PDF 本来就在你自己选的目录里，' +
          '而书目、笔记和标注是只有这里有的东西。',
        ok: '复制',
        cancel: '只导出数据'
      })
      if (go) copies = plan.copies
    }
    const fresh = await window.api.loadAnnotations()
    const freshNotes = await window.api.loadNotes()
    const allIds = new Set(docs.map((d) => d.id))
    const pickedIds = new Set(target.map((d) => d.id))
    const annsOut = fresh.filter((a) => pickedIds.has(a.docId) || !allIds.has(a.docId))
    const notesOut = target.filter((d) => (freshNotes[d.id] ?? '').trim())
    const files = [
      { name: 'library.bib', text: toBibtex(target) },
      { name: 'library.ris', text: toRis(target) },
      { name: 'library.endnote.xml', text: toEndnoteXml(target) },
      { name: 'README.txt', text: toExitReadme({
        docs: target.length,
        notes: notesOut.length,
        anns: annsOut.length,
        pdfs: copies.length
      }) }
    ]
    if (notesOut.length) {
      files.push({ name: 'notes.md', text: toNotesMarkdown(notesOut, freshNotes) })
    }
    if (annsOut.length) {
      files.push({ name: 'annotations.md', text: toAnnotationsMarkdown(target, annsOut, docs) })
    }
    const off = window.api.onLeaveProgress((p) => {
      if (p.phase === 'pdf') setBatchMsg(`复制 PDF ${p.done}/${p.total}…`)
    })
    try {
      const r = await window.api.leaveLibrary(dir, files, copies)
      if (r.error) setErr(`导出失败：${r.error}`)
      else {
        const bits = [`${target.length} 篇`, `${files.length} 个文件`]
        if (copies.length) bits.push(`${r.copied ?? 0} 份 PDF`)
        if (r.failed?.length) bits.push(`${r.failed.length} 份失败`)
        setBatchMsg(`已放到 ${dir}：${bits.join(' · ')}`)
        setTimeout(() => setBatchMsg(null), 12000)
      }
    } finally {
      off()
    }
  }

  /** Whether there is anything to export.  Same shape as the notes: this is
   *  recomputed on every keystroke, so the empty case — most libraries —
   *  answers without walking the list. */
  const canExportAnnotations = useMemo(() => {
    if (!anns.length) return false
    const have = new Set(anns.map((a) => a.docId))
    return target.some((d) => have.has(d.id))
  }, [target, anns])

  return {
    exportBib,
    exportRis,
    exportEndnote,
    exportNotes,
    exportAnnotations,
    leaveLibrary,
    canExportNotes,
    canExportAnnotations
  }
}
