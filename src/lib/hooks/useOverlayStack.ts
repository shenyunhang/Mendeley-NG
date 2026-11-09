import { useCallback, useState } from 'react'
import { topOverlay, type OverlayLayer } from '../overlayStack'

/**
 * The floating layers over the library: the settings sheet and the three
 * toolbar cards, plus the section the sheet was asked to open on.
 *
 * They belong together because one Escape press may close only the topmost
 * one. Keeping the states next to the rule in overlayStack.ts is what stops a
 * new card from being added without deciding where in the order it goes. The
 * reading view and the multi-selection are deliberately not here: they are
 * not floating layers, and the app still owns the part of Escape that leaves
 * them.
 */
export function useOverlayStack() {
  const [showFilters, setShowFilters] = useState(false)
  const [showSort, setShowSort] = useState(false)
  const [showCols, setShowCols] = useState(false)
  const [settings, setSettings] = useState(false)
  /** Which section the settings sheet opens on, when it was opened because
   *  something else named a setting rather than because 设置 was pressed. */
  const [setSec, setSetSec] = useState<string | null>(null)

  /** Close exactly the topmost layer. Returns true when this press belonged to
   *  the stack, so the caller stops before the reader/selection branches and
   *  one key press never does twice what it was asked. */
  const closeTopOnEscape = useCallback(
    (e: KeyboardEvent): boolean => {
      const top: OverlayLayer | null = topOverlay({
        settings,
        columns: showCols,
        sort: showSort,
        filters: showFilters
      })
      if (!top) return false
      e.preventDefault()
      switch (top) {
        case 'settings':
          setSettings(false)
          // and the section it was opened on: a sheet asked for from the
          // full-text panel opens on 全文检索, and one asked for from the
          // toolbar has no business landing there the next time
          setSetSec(null)
          break
        case 'columns':
          setShowCols(false)
          break
        case 'sort':
          setShowSort(false)
          break
        case 'filters':
          setShowFilters(false)
          break
      }
      return true
    },
    [settings, showCols, showSort, showFilters]
  )

  return {
    showFilters,
    setShowFilters,
    showSort,
    setShowSort,
    showCols,
    setShowCols,
    settings,
    setSettings,
    setSec,
    setSetSec,
    closeTopOnEscape
  }
}
