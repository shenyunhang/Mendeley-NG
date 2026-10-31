import type { Folder } from '../../shared/types'

/**
 * Display order for folders.
 *
 * Mendeley hands folders back in whatever order the catalogue holds them,
 * which is stable but arbitrary: the same folder lands in a different place
 * on a different machine, and finding one means reading down the column
 * until it turns up.  Sorting by name is what 1.19.8 did and what makes a
 * folder's position predictable.
 *
 * `numeric` so that "第 2 章" comes before "第 10 章" rather than after it,
 * which is what comparing the strings plainly gives.  `base` sensitivity so
 * that a difference in case alone does not push two spellings of one name
 * to opposite ends of the list.
 */
export const byName = (a: Folder, b: Folder) =>
  a.name.localeCompare(b.name, 'zh', { numeric: true, sensitivity: 'base' })

export interface Tree {
  /** folders with no parent, in display order */
  roots: Folder[]
  children: Map<string, Folder[]>
  /** the folder itself plus everything nested under it */
  subtree: Map<string, string[]>
  depth: Map<string, number>
  /** folders whose parent id points at a folder we do not have */
  orphans: Folder[]
}

/**
 * Folder nesting.  1.19.8 supported subfolders and the API gives us
 * `parent_id`, but the tree was rendered flat, which made nesting invisible.
 *
 * `subtree` exists so that selecting a folder also shows what is inside its
 * children — a parent that appears empty while its subfolders hold documents
 * is worse than useless.
 */
export function buildTree(folders: Folder[]): Tree {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const children = new Map<string, Folder[]>()
  const roots: Folder[] = []
  const orphans: Folder[] = []

  for (const f of folders) {
    const p = f.parent_id
    if (!p) {
      roots.push(f)
      continue
    }
    if (!byId.has(p)) {
      // parent missing (deleted, or belongs to someone else's group): show at
      // the top level rather than silently dropping the folder
      orphans.push(f)
      roots.push(f)
      continue
    }
    const list = children.get(p)
    if (list) list.push(f)
    else children.set(p, [f])
  }

  const depth = new Map<string, number>()
  const subtree = new Map<string, string[]>()

  const walk = (id: string, d: number, seen: Set<string>, out: string[]) => {
    if (seen.has(id)) return // cycle guard: a bad parent_id must not hang the UI
    seen.add(id)
    depth.set(id, d)
    out.push(id)
    for (const c of children.get(id) ?? []) walk(c.id, d + 1, seen, out)
  }

  // sorted here rather than where the tree is rendered, so that every place
  // that lists folders — the column, the "add to folder" menu, the details
  // panel — shows them in the same order without each one sorting for itself
  roots.sort(byName)
  for (const list of children.values()) list.sort(byName)

  for (const r of roots) {
    const out: string[] = []
    walk(r.id, 0, new Set(), out)
    subtree.set(r.id, out)
  }

  return { roots, children, subtree, depth, orphans }
}

/** True when `candidate` is `id` itself or nested underneath it. */
export function isSelfOrDescendant(tree: Tree, id: string, candidate: string): boolean {
  return (tree.subtree.get(id) ?? [id]).includes(candidate)
}
