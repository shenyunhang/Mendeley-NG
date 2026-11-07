import type { Doc } from '../../shared/types'

/**
 * Mendeley's document types are not BibTeX or RIS type names.
 *
 * The exporters used to test `Doc.type` against `['article', 'book',
 * 'inproceedings', ...]`, which is the *output* vocabulary. Every Mendeley
 * type except the coincidentally identical `book` fell through to `@misc` /
 * `GEN`, so a journal article round-tripped back into the library as
 * `generic`. One table, two projections, and the source-field decision all
 * live here so the three can never disagree again.
 */
const TYPES: Record<string, [bibtex: string, ris: string]> = {
  journal: ['article', 'JOUR'],
  conference_proceedings: ['inproceedings', 'CONF'],
  book: ['book', 'BOOK'],
  book_section: ['incollection', 'CHAP'],
  thesis: ['phdthesis', 'THES'],
  report: ['techreport', 'RPRT'],
  working_paper: ['unpublished', 'GEN'],
  web_page: ['misc', 'ELEC'],
  patent: ['misc', 'PAT'],
  magazine_article: ['article', 'MGZN'],
  newspaper_article: ['article', 'NEWS'],
  computer_program: ['misc', 'COMP'],
  generic: ['misc', 'GEN']
}

const pair = (d: Doc): [string, string] => TYPES[d.type ?? ''] ?? ['misc', 'GEN']

export const bibtexType = (d: Doc): string => pair(d)[0]
export const risType = (d: Doc): string => pair(d)[1]

/** A journal/magazine/newspaper source is a journal, all others are a
 *  booktitle (BibTeX) or a secondary title (RIS). This is about the document
 *  type, never about the BibTeX name we just produced. */
export const hasJournalField = (d: Doc): boolean =>
  d.type === 'journal' || d.type === 'magazine_article' || d.type === 'newspaper_article'
