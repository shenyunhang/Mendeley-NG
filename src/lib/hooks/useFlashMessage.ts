import { useEffect, useRef, useState } from 'react'
import { createFlashMessage, type FlashMessage } from '../flash'

/**
 * The React side of `createFlashMessage`: one piece of state, one controller
 * that owns the timer, and a cleanup on unmount.
 *
 * The controller is built once and kept in a ref. It closes over React's
 * `setState`, which is stable for the life of the component, so the functions
 * handed back are safe to pass into a callback installed once — the same
 * reason `useUndo` keeps its stack behind a ref.
 *
 * Two instances live in `App`, one for the batch/result line and one for the
 * import line. They are separate messages on screen, so they get separate
 * timers; a copy that clears itself must not take an import down with it.
 */
export function useFlashMessage() {
  const [message, setMessage] = useState<string | null>(null)
  const ctrl = useRef<FlashMessage<string> | null>(null)
  if (ctrl.current === null) ctrl.current = createFlashMessage<string>(setMessage)

  const flash = ctrl.current
  useEffect(() => () => flash.dispose(), [flash])

  return {
    message,
    flash: flash.flash,
    show: flash.show,
    clear: flash.clear
  }
}
