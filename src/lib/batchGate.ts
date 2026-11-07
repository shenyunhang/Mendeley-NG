/**
 * One batch download at a time.
 *
 * Two syncs in a row, or a sync plus the batch button, used to start two
 * downloads over the same list: the same document was fetched twice and got
 * an `xxx (2).pdf`, two progress bars wrote over each other, and the two
 * finished reports disagreed. The rule is separated from React so the second
 * start can be refused with no window and no network.
 */
export interface BatchGate {
  isRunning(): boolean
  tryStart(): boolean
  finish(): void
}

export function createBatchGate(): BatchGate {
  let running = false
  return {
    isRunning: () => running,
    tryStart: () => {
      if (running) return false
      running = true
      return true
    },
    finish: () => {
      running = false
    }
  }
}
