/**
 * Delays that are part of how the interface behaves, not arbitrary waits.
 *
 * Every one of these used to be a bare literal at its call site. They are
 * gathered here so that a change to one is a change to a named decision, and
 * so that the two 400ms persistence debounces stay separate: columns and
 * panes happen to wait the same amount of time today, but either may need to
 * change on its own.
 *
 * These are all renderer-side. Test waits in `electron/main/smoke.ts` are
 * deliberately not here -- a test's patience is not a product behaviour.
 */

/** Let the downloaded installer settle before quitting to run it. */
export const UPDATE_INSTALL_DELAY_MS = 700

/** How long the "copied" hint stays on the setup guide. */
export const COPIED_FEEDBACK_VISIBLE_MS = 1400

/** How long a highlight made from a text selection can be taken back. */
export const HIGHLIGHT_UNDO_WINDOW_MS = 8000

/** Typing pause before walking the pages of the open PDF for a term. */
export const FIND_QUERY_DEBOUNCE_MS = 250

/** Typing pause before asking the full-text index for a term. */
export const FULL_TEXT_QUERY_DEBOUNCE_MS = 250

/** Drag has stopped before column widths are written to disk. */
export const COLUMN_WIDTH_PERSIST_DEBOUNCE_MS = 400

/** Drag has stopped before pane widths are written to disk. */
export const PANE_WIDTH_PERSIST_DEBOUNCE_MS = 400

/** Reading position has settled before it is written to disk. */
export const READING_POSITION_PERSIST_DEBOUNCE_MS = 600
