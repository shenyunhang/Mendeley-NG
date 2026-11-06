/**
 * How many backing-store pixels a page canvas needs.
 *
 * pdf.js draws in CSS pixels; a canvas is sized in device pixels. Four places
 * used to write `Math.floor(viewport.width * dpr)` and the matching height by
 * hand -- three in the single-page viewer (two writes and the cache size
 * check) and one in the continuous column. If the check and the writes ever
 * disagree, every prefetched bitmap misses and the reader silently rerenders
 * every page, so the rule has to be one function, not four copies.
 *
 * Nothing here touches the DOM. `devicePixelRatioOrOne` takes the raw value
 * rather than reading `window`, which keeps the `|| 1` fallback testable in
 * the main-process smoke run.
 */

export interface CssSize {
  width: number
  height: number
}

export interface PixelSize {
  width: number
  height: number
}

/** `window.devicePixelRatio` is 0, NaN or missing often enough to matter. */
export function devicePixelRatioOrOne(raw: number): number {
  return raw || 1
}

/** Truncate down, exactly as the four old expressions did. */
export function bitmapPixelSize(viewport: CssSize, dpr: number): PixelSize {
  return {
    width: Math.floor(viewport.width * dpr),
    height: Math.floor(viewport.height * dpr)
  }
}
