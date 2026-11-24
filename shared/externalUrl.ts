/**
 * Only web addresses may be handed to the OS shell. `file:`, `smb:`,
 * `javascript:` and every other scheme are refused rather than filtered,
 * because the set of dangerous schemes is not a fixed list.
 *
 * This rule lives in its own module because the renderer needs it too, to
 * decide which links are worth drawing. `pathPolicy.ts` imports `node:path`
 * and therefore cannot be bundled into the browser build; it re-exports this
 * function so the main process keeps the one import it already had.
 */
export function isSafeExternalUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw) return false
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}
