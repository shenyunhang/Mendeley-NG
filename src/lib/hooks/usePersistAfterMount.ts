import { useEffect, useRef } from 'react'

/**
 * Write a value to disk after the first change, not on the mount that reads
 * it back.
 *
 * The mount is not a change: writing from it would put the value that was
 * just loaded straight back onto the disk, and on a slow start would race
 * the read that produced it. The debounce means one write per settled change
 * rather than one per frame of a drag. Both the column widths and the pane
 * widths are remembered this way for the same two reasons.
 *
 * `values` is the dependency list itself, so a change to any of them starts
 * a new timer and cancels the old one.
 */
export function usePersistAfterMount(
  values: readonly unknown[],
  write: () => void,
  delay: number
) {
  const touched = useRef(false)
  useEffect(() => {
    // the first run is the mount, not a change
    if (!touched.current) {
      touched.current = true
      return
    }
    const t = setTimeout(write, delay)
    return () => clearTimeout(t)
    // `values` is the dependency list itself, not a closure to inspect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, values)
}
