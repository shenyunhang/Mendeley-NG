/**
 * What the note box shows for the annotation that is selected now.
 *
 * The box used to hold a bare string that only two of the paths changing the
 * selection remembered to reset. Drawing a new highlight selects it without
 * touching that string, so the reader saw paper A's note in a box that would,
 * on Enter or blur, write it onto highlight B. Deriving the shown text from
 * the selection makes every setter correct at once: an untyped edit belongs
 * to the annotation it was typed against and to no other.
 */
export interface NoteSelection {
  id: string
  note?: string | null
}

export function noteForSelection(
  selected: NoteSelection | null,
  draft: { id: string; text: string } | null
): string {
  if (!selected) return ''
  if (draft?.id === selected.id) return draft.text
  return selected.note ?? ''
}
