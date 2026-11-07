/**
 * The day Mendeley says a document joined the library.
 *
 * `created` arrives as an ISO timestamp; the list column and the details pane
 * both show just the day, and a reader who wants the exact moment gets it from
 * the field's `title`. Keeping the trimming here means the two can never
 * disagree about what "添加时间" means, and the rule can be checked without
 * opening a window.
 *
 * Deliberately not parsed into a Date: the API has always returned
 * `YYYY-MM-DDTHH:mm:ss.sssZ`, and parsing would introduce time zones and
 * off-by-one days into a column that is only showing a label. An empty or
 * absent value stays empty; the caller decides what to show instead.
 */
export function shortDate(s?: string | null): string {
  return s ? s.slice(0, 10) : ''
}
