import { useCallback, useEffect, useRef, useState } from 'react'
import type { FtHit, FtStatus } from '../../../shared/types'
import {
  answerFor,
  createLatestSearch,
  type LatestSearch,
  type SearchAnswer
} from '../latestSearch'

/**
 * Full-text search, as a state of its own.
 *
 * The word that was typed, the hits it came back with, what the index is up
 * to, and whether the panel being read is this one at all.  It hangs together
 * because every one of those is about the same question — what is in the
 * bodies of the papers — and none of them is about the catalogue, the
 * selection or the cloud.
 *
 * It also owns the one subscription the rest of the app has no opinion about:
 * index progress arrives whether or not anybody asked, and it is what decides
 * that a search already on screen has to be run again.
 *
 * Whether this panel is the one being read is *not* its business and is
 * passed in.  It used to own that flag too, and then the flag had to be kept
 * in step with the eight-way ternary that decided what the middle of the
 * window was; now the view says it, and there is one answer.
 */
export function useFullText(active: boolean) {
  const [ftQuery, setFtQuery] = useState('')
  /**
   * An answer is kept with the word that produced it. The old plain array
   * could not say that, and the view would render hits from a word the
   * reader had already replaced. See `latestSearch.ts`.
   */
  const [answer, setAnswer] = useState<SearchAnswer<string, FtHit[]> | null>(null)
  const [ftStat, setFtStat] = useState<FtStatus | null>(null)

  /**
   * Bumped whenever the corpus finishes changing, so that a search which came
   * back empty gets asked again.
   *
   * A search is only run when the words change, so building the index after
   * searching leaves the old answer on the screen: "正文里没找到" stays there
   * over a library that has since been read in full, and the reader is left
   * to conclude that the word is not in their papers.  The words did not
   * change, so only the index finishing can be what prompts the second look.
   */
  const [ftEpoch, setFtEpoch] = useState(0)

  /**
   * The controller lives in a ref, as `useUndo`'s stack and
   * `useFlashMessage`'s timer do: it is built once, closes over React's stable
   * `setState`, and must outlive the effect that starts each lookup.
   */
  const search = useRef<LatestSearch<string, FtHit[]> | null>(null)
  if (search.current === null) {
    search.current = createLatestSearch<string, FtHit[]>(
      (q) => window.api.ftSearch(q),
      setAnswer,
      []
    )
  }
  useEffect(() => () => search.current?.cancel(), [])

  const wasBuilding = useRef(false)
  useEffect(() => {
    // The edge, rather than every update: a build reports progress once per
    // paper, and a search is not wanted a thousand times over.
    return window.api.onFtProgress((s) => {
      setFtStat(s)
      if (wasBuilding.current && !s.building) setFtEpoch((e) => e + 1)
      wasBuilding.current = !!s.building
    })
  }, [])

  /**
   * Start a build, or a rebuild.
   *
   * The answer to `ftBuild` is the status the run *starts* with, not the one
   * it ends with, so the flag is set from here as well as from the progress
   * above: a run short enough never to report progress still has to end the
   * search's wait, or the answer "not found" stays up over a library that has
   * since been read in full.
   */
  const build = useCallback((rebuild: boolean) => {
    window.api.ftBuild(rebuild).then((s) => {
      setFtStat(s)
      wasBuilding.current = !!s.building
    })
  }, [])

  const cancel = useCallback(() => {
    window.api.ftCancel().then(setFtStat)
  }, [])

  /** The index goes, and the hits go with it: they are hits into text that is
   *  no longer there, and leaving them up reads as a search that worked. */
  const clear = useCallback(() => {
    window.api.ftClear().then((s) => {
      setFtStat(s)
      search.current?.cancel()
      setAnswer(null)
    })
  }, [])

  // The search runs in the main process against the whole corpus, so it is
  // debounced: typing a word should not start one scan per keystroke.
  // There is deliberately no cleanup on this effect. `ask` supersedes the
  // previous question itself, so a cleanup would only do the same thing
  // twice; the permanent unmount cleanup above is the one that matters.
  useEffect(() => {
    const q = ftQuery.trim()
    if (!active || q.length < 2) {
      search.current?.cancel()
      return
    }
    search.current?.ask(q, 250)
  }, [active, ftQuery, ftEpoch])

  const current = ftQuery.trim()
  const matching = answerFor(answer, current)
  const ftHits = matching ?? []
  /**
   * An answer tagged with an older word is not an answer to this one, and
   * neither is no answer at all. Both mean a lookup is still out, which is
   * the truth to put on screen instead of old rows or a premature "没找到".
   * Empty results are *not* `null`, so a real "not found" is still a "not
   * found" rather than a search that never ends.
   */
  const ftSearching = current.length >= 2 && matching === null

  return {
    ftQuery,
    setFtQuery,
    ftHits,
    ftSearching,
    ftStat,
    setFtStat,
    build,
    cancel,
    clear
  }
}
