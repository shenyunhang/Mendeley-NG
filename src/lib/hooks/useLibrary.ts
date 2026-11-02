import { useCallback, useEffect, useRef, useState } from 'react'
import type { Folder, Library, SyncStatus } from '../../../shared/types'

/**
 * The library, and the two ways it arrives.
 *
 * Everything here is about one question: what does this machine currently
 * know about the reader's papers.  The cache on disk, the pull from the
 * cloud, whether there is a token to pull with, and how far the pull has got.
 * The app's other concerns — which folder is open, what is selected, what the
 * columns are — are none of this hook's business, which is the whole reason it
 * can be read on its own.
 *
 * `setLib` is handed out rather than kept private because the catalogue is
 * edited in place all over the app: a paper trashed, a folder membership
 * added, a PDF matched, all change the cached library directly so the list
 * does not have to wait for the cloud to be asked again.
 */
export function useLibrary(syncOnStart: boolean, onError: (message: string | null) => void) {
  const [lib, setLib] = useState<Library | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [busy, setBusy] = useState(false)
  /** `null` means the question has not been answered yet, which is not the
   *  same as "no": a first-run guide shown because a token check was assumed
   *  rather than read is a guide shown to somebody who is already signed in. */
  const [hasToken, setHasToken] = useState<boolean | null>(null)
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.api.loadLibrary().then((r) => {
      if (r && !('error' in r) && r.docs) {
        setLib(r)
        setFolders(r.folders ?? [])
      }
    })
    window.api.appVersion().then(setVersion).catch(() => {})
    window.api.hasToken().then(setHasToken).catch(() => setHasToken(false))
    return window.api.onSyncStatus(setStatus)
  }, [])

  /** `full` re-pulls the whole library.  Incremental is the default because a
   *  5.6k-document pull takes long enough to be annoying, but deletions are
   *  only visible to a full one, which is why that stays one click away. */
  const sync = useCallback(
    async (full = false) => {
      setBusy(true)
      onError(null)
      const r = await window.api.sync(full)
      if (r && 'error' in r) {
        // the banner no longer says "sync failed" on every message, so the one
        // that is about syncing has to say so itself
        onError('同步失败：' + r.error + '　（可能需要导入 token.json）')
      } else if (r) {
        setLib({ docs: r.docs, folders: r.folders, syncedAt: new Date().toISOString() })
        setFolders(r.folders)
      }
      setBusy(false)
    },
    [onError]
  )

  /**
   * One quiet pull at start-up.
   *
   * The library on disk is a cache of the cloud, and a cache refreshed only
   * when somebody remembers to press 同步 is stale by exactly the work done
   * on the other machine.  Incremental, because a full pull of five thousand
   * papers is long enough to be noticed and nothing here needs it.
   *
   * Silent, and that is the whole design: a red banner on every launch that
   * happened to be offline is worse than a list that is a few hours behind,
   * and the reader never asked to be told.  Whoever wants to know can press
   * the button, which is loud on purpose.
   *
   * It waits for the token question to be answered rather than assuming it —
   * `sync` throws `NO_TOKEN` otherwise, and an error at start-up is the one
   * kind of error that gets read.
   */
  const startedSync = useRef(false)
  useEffect(() => {
    if (!syncOnStart || hasToken !== true || startedSync.current) return
    startedSync.current = true
    window.api
      .sync(false)
      .then((r) => {
        if (r && !('error' in r)) {
          setLib({ docs: r.docs, folders: r.folders, syncedAt: new Date().toISOString() })
          setFolders(r.folders)
        }
      })
      .catch(() => {
        /* a start-up pull that failed is not news: the cached library is
           still on screen, and the button says when it last worked */
      })
  }, [syncOnStart, hasToken])

  /** A token has just been imported.  The answer is asserted rather than
   *  asked again, because the guide is waiting on it and a round trip through
   *  the main process would leave the button doing nothing for a moment. */
  const markToken = useCallback(() => setHasToken(true), [])

  return { lib, setLib, folders, setFolders, status, busy, hasToken, version, sync, markToken }
}
