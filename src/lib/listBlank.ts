/**
 * Whether a click in a list landed outside every row.
 *
 * Both lists are virtualised: what is on screen is a window over thousands of
 * rows, and a click on the container below the last one has no row to name.
 * Row clicks bubble up to the container, so the decision has to be made on
 * the event target itself — a click on a star, a marked word or a column
 * value is still a click on its row, not a request to drop the selection.
 *
 * The target is only asked for `closest`, so the rule can be checked with a
 * small object instead of a real element. The row class is a parameter
 * because the table calls its rows `row` and the search cards `res-row`.
 */
export function isListBlank(target: unknown, rowClass: string): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null
  if (!el || typeof el.closest !== 'function') return true
  return !el.closest('.' + rowClass)
}
