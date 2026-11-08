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
 *
 * `enabled` is false until the config has actually been read back.  Without
 * it the asynchronous hydrate looks exactly like the first user change: the
 * effect writes the value it just loaded straight back to disk, which is the
 * race the mount guard exists to prevent.  While disabled the guard is reset,
 * so the first run after hydration is treated as the mount again.
 */
export function usePersistAfterMount(
  values: readonly unknown[],
  write: () => void,
  delay: number,
  enabled = true
) {
  const touched = useRef(false)
  useEffect(() => {
    if (!enabled) {
      touched.current = false
      return
    }
    // the first run is the mount, not a change
    if (!touched.current) {
      touched.current = true
      return
    }
    const t = setTimeout(write, delay)
    return () => clearTimeout(t)
    // `values` is the dependency list itself, not a closure to inspect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...values, enabled])
}
