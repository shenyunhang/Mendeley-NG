/**
 * Run one cloud call per item and say afterwards what actually happened.
 *
 * A batch that quietly does less than it was asked is worse than one that
 * fails outright: two hundred documents, three of which did not make it,
 * reads as two hundred documents, and the three are discovered later as
 * "this thing does not work".  There is no transaction across PATCHes, so
 * partial success is the ordinary case and not an accident.
 *
 * Progress is reported in at most twenty steps, because setting state once
 * per document re-renders the table once per document.
 *
 * Nothing here touches React or the DOM: the caller owns the progress state.
 * It used to live inside App.tsx, which made it look like part of the
 * component's state machine when it is really a rule about batches.
 */
export async function runBatch<T>(
  items: T[],
  name: (t: T) => string,
  run: (t: T) => Promise<void>,
  onProgress: (done: number, total: number) => void
): Promise<{ ok: number; failed: string[] }> {
  const failed: string[] = []
  let ok = 0
  const every = Math.max(1, Math.floor(items.length / 20))
  for (let i = 0; i < items.length; i++) {
    try {
      await run(items[i]!)
      ok++
    } catch {
      // one failure must not abandon the rest of the batch
      failed.push(name(items[i]!))
    }
    if (i % every === 0 || i === items.length - 1) onProgress(i + 1, items.length)
  }
  return { ok, failed }
}
