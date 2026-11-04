import { useRef, useState } from 'react'
import type { Doc } from '../../../shared/types'

/**
 * The selection state: which paper the right pane is on, which rows are in
 * the multi-selection, and the anchor the next shift-click spans from.
 *
 * A bag of state rather than a model, on purpose — the same admission
 * `useConfig` makes.  What is done with these is spread across the whole app
 * (the keydown handler reads the selection through refs, the row menu acts on
 * it, the right pane shows it), and a hook that also tried to own the actions
 * would have to be handed `filtered`, the trash handler and the pane switcher
 * just to build its own closures.  So only the state lives here; the things
 * that read and write it stay where they can see the rest of the app.
 *
 * `pinned` is a paper the right pane is showing that is not in the library.
 * The bin lists documents that doc:trash already took out of `docs`, so
 * resolving the selection from `filtered`/`docs` alone leaves the pane asking
 * to be given a paper again the moment one of them is pressed.  Holding the
 * record itself is what makes "open it" mean something there.
 */
export function useSelection() {
  const [selId, setSelId] = useState<string | null>(null)
  const [pinned, setPinned] = useState<Doc | null>(null)
  const [multi, setMulti] = useState<string[]>([])
  /** The last row clicked, kept in a ref because it is not something the
   *  table should re-render for: it is only the anchor for the next
   *  shift-click range. */
  const lastIdx = useRef<number | null>(null)

  return { selId, setSelId, pinned, setPinned, multi, setMulti, lastIdx }
}
