/**
 * The document types Mendeley accepts.
 *
 * This is not a free-text field: the API takes a fixed vocabulary and a value
 * outside it is rejected, so the same list is used wherever a type can be
 * set.  It is also the list `export.ts` maps EndNote reference types through,
 * so a type chosen here survives a round trip out of the library.
 */
export const DOC_TYPES = [
  'journal',
  'conference_proceedings',
  'book',
  'book_section',
  'thesis',
  'report',
  'working_paper',
  'web_page',
  'patent',
  'magazine_article',
  'newspaper_article',
  'computer_program',
  'generic'
] as const

/** Labels for the same values, for anything that shows them to a person. */
export const DOC_TYPE_LABELS: Record<string, string> = {
  journal: '期刊论文',
  conference_proceedings: '会议论文',
  book: '书',
  book_section: '章节',
  thesis: '学位论文',
  report: '报告',
  working_paper: '工作论文',
  web_page: '网页',
  patent: '专利',
  magazine_article: '杂志文章',
  newspaper_article: '报纸文章',
  computer_program: '程序',
  generic: '其他'
}
