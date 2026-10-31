import type { Doc } from '../../shared/types'

/** The columns the document table can show, in the order they are offered. */
export type ColKey =
  | 'star'
  | 'pdf'
  | 'authors'
  | 'title'
  | 'year'
  | 'source'
  | 'citation_key'
  | 'tags'
  | 'read'
  | 'type'
  | 'created'

/** Keys the table can sort by; a column without one is display-only. */
export type SortKey =
  | 'title'
  | 'authors'
  | 'year'
  | 'source'
  | 'citation_key'
  | 'starred'
  | 'created'

export interface ColumnDef {
  key: ColKey
  label: string
  /** the grid track this column gets */
  track: string
  /** Narrowest the column can be dragged, in CSS px.  Absent means the
   *  generic floor, which is wider than the two icon columns need. */
  min?: number
  sort?: SortKey
  /** plain text, used for the tooltip and for anything that needs the value
   *  without its cell chrome */
  text: (d: Doc) => string
  /** only these two are not plain text: one is a toggle, one is a dot */
  kind?: 'star' | 'pdf'
}

const firstAuthor = (d: Doc) => {
  const a = d.authors?.[0]
  if (!a) return ''
  return [a.last_name, a.first_name].filter(Boolean).join(' ')
}

const shortDate = (s?: string) => (s ? s.slice(0, 10) : '')

export const COLUMNS: ColumnDef[] = [
  { key: 'star', label: '★', track: '24px', min: 24, sort: 'starred', text: (d) => (d.starred ? '★' : ''), kind: 'star' },
  {
    key: 'pdf',
    label: '',
    track: '26px',
    min: 26,
    text: (d) => (d.localPdf ? '本地 PDF' : d.file_attached ? '云端有文件' : '无 PDF'),
    kind: 'pdf'
  },
  {
    key: 'authors',
    label: '作者',
    track: '1.5fr',
    sort: 'authors',
    text: (d) => firstAuthor(d) + ((d.authors?.length ?? 0) > 1 ? ' 等' : '')
  },
  { key: 'title', label: '标题', track: '3.2fr', sort: 'title', text: (d) => d.title || '(无标题)' },
  { key: 'year', label: '年份', track: '56px', sort: 'year', text: (d) => (d.year == null ? '' : String(d.year)) },
  { key: 'source', label: '发表处', track: '1.3fr', sort: 'source', text: (d) => d.source ?? '' },
  { key: 'citation_key', label: 'Key', track: '1.1fr', sort: 'citation_key', text: (d) => d.citation_key ?? '' },
  { key: 'tags', label: '标签', track: '1.1fr', text: (d) => (d.tags ?? []).join(', ') },
  { key: 'read', label: '已读', track: '52px', text: (d) => (d.read === false ? '未读' : '已读') },
  { key: 'type', label: '类型', track: '0.8fr', text: (d) => d.type ?? '' },
  { key: 'created', label: '添加时间', track: '96px', sort: 'created', text: (d) => shortDate(d.created) }
]

export const COL_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]))

/** What a fresh install shows; Mendeley's own default, roughly. */
export const DEFAULT_COLS: ColKey[] = [
  'star',
  'pdf',
  'authors',
  'title',
  'year',
  'source',
  'citation_key'
]

/** Drop unknown keys and enforce the registry order, so a view saved by an
 *  older build cannot produce a table with holes in it. */
export function normaliseCols(cols: string[] | undefined): ColKey[] {
  if (!cols?.length) return [...DEFAULT_COLS]
  const seen = new Set<ColKey>()
  for (const c of COLUMNS) {
    if (cols.includes(c.key)) seen.add(c.key)
  }
  return seen.size ? [...seen] : [...DEFAULT_COLS]
}

/** Narrowest a column with no floor of its own can be dragged. */
const MIN_PX = 48
/** Widest any column can be dragged.  Past this a single column is taking the
 *  whole window and the rest of the row is not readable anyway. */
const MAX_PX = 1000

/** Bring a dragged width into range.  Stored values go through this too, so a
 *  width from an older build cannot produce a column that cannot be seen. */
export function clampColWidth(def: ColumnDef, w: number): number {
  return Math.round(Math.max(def.min ?? MIN_PX, Math.min(MAX_PX, w)))
}

/**
 * The `grid-template-columns` value for a given set of columns.
 *
 * `widths` holds, per column, a pixel width the reader dragged to.  Only the
 * columns that were actually dragged are in it; the rest keep the track their
 * definition gives them, which is what lets one column take the slack.
 */
export function gridTemplate(cols: ColKey[], widths?: Record<string, number>): string {
  const tracks = cols.map((k) => {
    const def = COL_BY_KEY.get(k)
    if (!def) return '1fr'
    const w = widths?.[k]
    return w == null ? def.track : `${clampColWidth(def, w)}px`
  })
  // one flexible column has to exist or a narrow table leaves a gap at the
  // right; the title is the natural one to give the slack to
  if (!tracks.some((t) => t.endsWith('fr'))) tracks.push('1fr')
  return tracks.join(' ')
}
