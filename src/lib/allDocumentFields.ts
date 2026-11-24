import type { Doc } from '../../shared/types'

/**
 * Every field the cached record carries for one paper.
 *
 * The editable form draws a short list of citation fields. Everything else --
 * the identifiers beyond doi, dates, venue details, flags, and the arrays --
 * used to be invisible even though the catalogue returned it. This expands
 * the cached document into labelled rows, so no field is hidden. It is
 * strictly read-only: none of these values is patched back to the cloud.
 */
export interface DocumentField {
  /** The key as it appears in the cache, or a dotted / indexed path. */
  name: string
  value: string
}

const EMPTY = '—'

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return EMPTY
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** Authors and editors are objects; the row keeps every member in order. */
function personText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return text(value)
  const p = value as Record<string, unknown>
  const last = text(p.last_name)
  const first = text(p.first_name)
  if (last !== EMPTY && first !== EMPTY) return `${last}, ${first}`
  if (last !== EMPTY) return last
  return first
}

/**
 * One row per field, in the order the cache stores them. Plain objects such
 * as `identifiers` become dotted keys, arrays of scalars become indexed keys,
 * and arrays of people stay one row whose value lists every member. Empty and
 * missing values are marked rather than silently skipped.
 */
export function allDocumentFields(doc: Doc): DocumentField[] {
  const out: DocumentField[] = []
  const raw = doc as unknown as Record<string, unknown>

  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      if (!value.length) {
        out.push({ name, value: '[]' })
      } else if (value.every((v) => v === null || typeof v !== 'object')) {
        value.forEach((v, i) => out.push({ name: `${name}[${i}]`, value: text(v) }))
      } else {
        out.push({ name, value: value.map(personText).join('; ') })
      }
      continue
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
      if (!entries.length) out.push({ name, value: '{}' })
      else for (const [key, v] of entries) out.push({ name: `${name}.${key}`, value: text(v) })
      continue
    }
    out.push({ name, value: text(value) })
  }

  return out
}
