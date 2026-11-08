/** "Doe, Jane" keeps the surname first; a name with no comma is read
 *  surname-last ("Jane Doe"). Shared by the RIS and EndNote XML readers so
 *  the two importers cannot drift apart. */
export interface PersonName {
  last_name: string
  first_name: string
}

export function splitPersonName(raw: string): PersonName {
  const parts = raw.split(',')
  if (parts.length > 1) {
    return { last_name: parts[0].trim(), first_name: parts.slice(1).join(',').trim() }
  }
  const p = raw.split(/\s+/)
  return { last_name: p[p.length - 1], first_name: p.slice(0, -1).join(' ') }
}
