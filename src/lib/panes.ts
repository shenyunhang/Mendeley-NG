/**
 * Pane widths, and the room every pane is guaranteed.
 *
 * The list keeps at least `MID_MIN`: a table squeezed to a couple of columns
 * is worse than a reader that is a little narrower, and without a floor a
 * drag to the far right would leave the middle pane with nothing.
 *
 * These live outside `App` because two places need them and neither owns the
 * other: the hook that restores the remembered widths, and the drag handlers
 * that work out how far a pane may be pulled before the neighbours are
 * squeezed past their floors.
 */
export const DEFAULT_LEFT_W = 240
export const DEFAULT_RIGHT_PCT = 46
export const LEFT_MIN = 140
export const LEFT_MAX = 520
export const RIGHT_MIN = 22
export const RIGHT_MAX = 70
export const MID_MIN = 260

export const clampNum = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo

export const clampLeft = (v: number) => Math.round(clampNum(v, LEFT_MIN, LEFT_MAX))
export const clampRight = (v: number) =>
  Math.round(clampNum(v, RIGHT_MIN, RIGHT_MAX) * 10) / 10
