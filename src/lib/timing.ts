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
 *
 * Short-message durations joined in 168: they used to be bare arguments to
 * `flashBatch` / `flashImport`, so the same number was written out at a dozen
 * call sites without saying which message it belonged to. Equal values keep
 * separate keys on purpose -- four 2500s, two 3000s and three 6000s are not
 * one decision, and two decisions that happen to agree today may need to
 * change on their own tomorrow.
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

/** Quiet pause after launch before an unasked-for update check. */
export const STARTUP_UPDATE_CHECK_DELAY_MS = 4000

/** A clean batch result: long enough to read, short enough not to nag. */
export const BATCH_CLEAN_MESSAGE_VISIBLE_MS = 2500

/** A batch that lost something: the banner stays, so the note should too. */
export const BATCH_FAILED_MESSAGE_VISIBLE_MS = 5000

/** Bulk PDF rename finished. */
export const RENAME_RESULT_MESSAGE_VISIBLE_MS = 3000

/** A folder add or remove that had nothing to do. */
export const FOLDER_NOOP_MESSAGE_VISIBLE_MS = 2500

/** Every selected paper already has a local PDF. */
export const ALL_HAVE_PDF_MESSAGE_VISIBLE_MS = 2500

/** A stopped download still has to say how many landed. */
export const DOWNLOAD_STOPPED_MESSAGE_VISIBLE_MS = 3000

/** The generic "N items changed" note after a batch action. */
export const BATCH_ACTION_MESSAGE_VISIBLE_MS = 2200

/** A copied citation: the reader needs to see that it really copied. */
export const CITATION_COPIED_MESSAGE_VISIBLE_MS = 2400

/** Import finished; this line has its own flash controller. */
export const IMPORT_FINISHED_MESSAGE_VISIBLE_MS = 2500

/** Bibliography formats exported to a chosen path. */
export const EXPORT_BIBLIOGRAPHY_MESSAGE_VISIBLE_MS = 6000

/** Notes exported to a chosen path. */
export const EXPORT_NOTES_MESSAGE_VISIBLE_MS = 6000

/** Annotations exported to a chosen path. */
export const EXPORT_ANNOTATIONS_MESSAGE_VISIBLE_MS = 6000

/** "Take the whole library": the longest note, because the list is longest. */
export const EXPORT_LIBRARY_MESSAGE_VISIBLE_MS = 12000
