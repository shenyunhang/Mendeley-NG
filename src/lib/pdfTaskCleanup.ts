import { ignoreFailure, FAILURE } from '../../shared/failures'

/** Anything with pdf.js's loading-task lifetime. */
export interface DestroyableTask {
  destroy: () => Promise<void>
}

/**
 * Releasing a superseded PDF load.
 *
 * Clicking through rows starts a `getDocument()` for every click. Leaving the
 * earlier tasks alone lets each parse run to completion on the renderer's main
 * thread. Destroying the task stops the in-flight parse and releases the
 * document the previous row had opened. `destroy()` rejects when pdf.js has
 * already torn the worker down, which has no consequence for the reader, so
 * the decision goes through a named door rather than an empty catch.
 */
export function destroyLoadingTask(task: DestroyableTask): Promise<void> {
  return task.destroy().catch((e) => {
    ignoreFailure(FAILURE.workerCleanup, e)
  })
}
