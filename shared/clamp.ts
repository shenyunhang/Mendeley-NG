/**
 * Hold a number inside an inclusive range.
 *
 * This is exactly the plain `Math.min(max, Math.max(min, value))` rule, with
 * no special handling for non-finite input. That matters: `clampNum` in
 * `src/lib/panes.ts` treats NaN and infinity as "use the lower bound", which
 * is right for a dragged pane width but would silently change the answer of
 * every call site that used to write the expression out by hand. A shared
 * rule has to answer precisely what they answered.
 *
 * No rounding, no coercion, no fallback default. Those belong to the caller,
 * which is the only place that knows what the number means.
 */
export function clampToRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
