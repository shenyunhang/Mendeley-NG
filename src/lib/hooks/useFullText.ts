import { useCallback, useEffect, useRef, useState } from 'react'
import type { FtHit, FtStatus } from '../../../shared/types'

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
 */
export function useFullText() {
  const [ftMode, setFtMode] = useState(false)
  const [ftQuery, setFtQuery] = useState('')
  const [ftHits, setFtHits] = useState<FtHit[]>([])
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
      setFtHits([])
    })
  }, [])

  // The search runs in the main process against the whole corpus, so it is
  // debounced: typing a word should not start one scan per keystroke.
  useEffect(() => {
    if (!ftMode) return
    const q = ftQuery.trim()
    if (q.length < 2) {
      setFtHits([])
      return
    }
    const t = setTimeout(() => {
      window.api.ftSearch(q).then(setFtHits).catch(() => setFtHits([]))
    }, 250)
    return () => clearTimeout(t)
  }, [ftMode, ftQuery, ftEpoch])

  return {
    ftMode,
    setFtMode,
    ftQuery,
    setFtQuery,
    ftHits,
    setFtHits,
    ftStat,
    setFtStat,
    ftEpoch,
    build,
    cancel,
    clear
  }
}
