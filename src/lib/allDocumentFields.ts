import type { Doc } from '../../shared/types'

/**
 * Every field the cached record carries for one paper.
 *
 * The editable form draws a short list of citation fields. Everything else --
 * the identifiers beyond doi, dates, venue details, flags, and the arrays --
 * used to be invisible even though the catalogue returned it. This expands
 * the cached document into labelled rows and turns the fields the form does
 * not already own into editable inputs. Cloud-owned and locally filled fields
 * stay read-only rather than being sent back with a PATCH.
 */
export interface DocumentField {
  /** The key as it appears in the cache, or a dotted / indexed path. */
  name: string
  value: string
  /** The value as it came out of the cache, before it was turned into text. */
  raw: unknown
  editable: boolean
}

const EMPTY = '—'

/** Fields owned by the form above, by a dedicated control, or by the cloud.
 *  Editing them here would either fight the other control or send an id, a
 *  local PDF path or a server-owned flag back to the API. */
const OWNED_ELSEWHERE = new Set([
  'id', 'localPdf', 'created', 'last_modified', 'profile_id', 'file_attached',
  'confirmed', 'hidden', 'authored', 'private_publication', 'starred', 'read',
  'authors', 'editors', 'title', 'year', 'source', 'abstract', 'citation_key',
  'type', 'volume', 'issue', 'pages', 'publisher', 'url'
])
const OWNED_PREFIXES = ['identifiers.doi', 'keywords[', 'tags[', 'folder_uuids[']

export function isEditableField(name: string): boolean {
  return !OWNED_ELSEWHERE.has(name) && !OWNED_PREFIXES.some((p) => name.startsWith(p))
}

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
 * One row per field. Plain objects such as `identifiers` become dotted keys,
 * arrays of scalars become indexed keys, and arrays of people stay one row
 * whose value lists every member. Empty and missing values are marked rather
 * than silently skipped. Editable rows come first so their inputs are visible
 * without scrolling; within each group the cache order is kept.
 */
export function allDocumentFields(doc: Doc): DocumentField[] {
  const out: DocumentField[] = []
  const raw = doc as unknown as Record<string, unknown>

  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      if (!value.length) {
        out.push({ name, value: '[]', raw: value, editable: false })
      } else if (value.every((v) => v === null || typeof v !== 'object')) {
        value.forEach((v, i) => {
          const key = `${name}[${i}]`
          out.push({ name: key, value: text(v), raw: v, editable: isEditableField(key) })
        })
      } else {
        out.push({ name, value: value.map(personText).join('; '), raw: value, editable: false })
      }
      continue
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
      if (!entries.length) out.push({ name, value: '{}', raw: value, editable: false })
      else {
        for (const [key, v] of entries) {
          const path = `${name}.${key}`
          out.push({ name: path, value: text(v), raw: v, editable: isEditableField(path) })
        }
      }
      continue
    }
    out.push({ name, value: text(value), raw: value, editable: isEditableField(name) })
  }

  return [
    ...out.filter((f) => f.editable),
    ...out.filter((f) => !f.editable)
  ]
}

/** Keep the type the cache had, so editing `month` does not send a string. */
function coerce(next: string, raw: unknown): unknown {
  if (typeof raw === 'number') {
    const n = Number(next)
    return next.trim() !== '' && Number.isFinite(n) ? n : next
  }
  if (typeof raw === 'boolean') return next.trim().toLowerCase() === 'true'
  return next
}

/**
 * Turn edited rows back into a PATCH body. Dotted keys go under their parent
 * object and indexed keys rebuild the array, keeping the entries the reader
 * did not touch. The cloud silently ignores fields it does not accept, so the
 * response written back to the panel is what actually took effect.
 */
export function documentFieldsToPatch(
  edits: Record<string, string>,
  fields: DocumentField[],
  doc: Doc
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const rawByName = new Map(fields.map((f) => [f.name, f.raw]))
  const identifiers: Record<string, unknown> = { ...(doc.identifiers ?? {}) }
  let identifiersTouched = false
  const arrays = new Map<string, Map<number, string>>()

  for (const [name, next] of Object.entries(edits)) {
    const indexed = /^(.+)\[(\d+)\]$/.exec(name)
    if (indexed) {
      const [, base, at] = indexed
      const items = arrays.get(base) ?? new Map<number, string>()
      items.set(Number(at), next)
      arrays.set(base, items)
    } else if (name.startsWith('identifiers.')) {
      identifiers[name.slice('identifiers.'.length)] = coerce(next, rawByName.get(name))
      identifiersTouched = true
    } else {
      body[name] = coerce(next, rawByName.get(name))
    }
  }

  if (identifiersTouched) body.identifiers = identifiers
  const raw = doc as unknown as Record<string, unknown>
  for (const [base, items] of arrays) {
    const original = raw[base]
    const next = Array.isArray(original) ? [...original] : []
    for (const [i, value] of items) next[i] = coerce(value, next[i])
    body[base] = next
  }
  return body
}
