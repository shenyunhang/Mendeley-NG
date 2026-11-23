/**
 * The one copy of the custom title bar's geometry and colours.
 *
 * On Windows the native title bar is hidden and Chromium draws only the three
 * window controls on top of the page (titleBarOverlay).  Those controls are OS
 * chrome, not DOM, so their colours cannot come from CSS variables: the main
 * process has to be told the same values the renderer uses for --bg-2 (the
 * strip) and --fg (the glyphs).  Keeping them here means the theme toggle and
 * the first window creation cannot disagree, and tests/title-bar-theme.test.ts
 * checks the CSS still matches.
 */

export const TITLE_BAR_HEIGHT = 34

export interface TitleBarColors {
  /** Overlay and pre-render window background; mirrors --bg-2. */
  color: string
  /** Native min/max/close glyph colour; mirrors --fg. */
  symbolColor: string
  height: number
}

export function titleBarColorsFor(theme?: 'dark' | 'light'): TitleBarColors {
  return theme === 'light'
    ? { color: '#ffffff', symbolColor: '#1c1e21', height: TITLE_BAR_HEIGHT }
    : { color: '#212121', symbolColor: '#e8e8e8', height: TITLE_BAR_HEIGHT }
}
