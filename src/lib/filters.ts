import type { Doc } from '../../shared/types'

/**
 * The conditions that narrow the list, beyond the search box and the folder.
 *
 * Each one answers a question the table can already show but cannot isolate:
 * how much of what I saved have I actually read, what have I not got a file
 * for, what is on the cloud that is not on this disk, what is floating free
 * of any folder.  All four are things a reader wants to work through, and
 * before this they were only visible as one column among many to be eyeballed.
 */
export type ListFilter = 'star' | 'unread' | 'nopdf' | 'cloud' | 'unfiled'

export const LIST_FILTERS: ListFilter[] = ['star', 'unread', 'nopdf', 'cloud', 'unfiled']

export const FILTER_LABEL: Record<ListFilter, string> = {
  star: '星标',
  unread: '未读',
  nopdf: '没有本地 PDF',
  cloud: '云端有本地没有',
  unfiled: '未归入文件夹'
}

/** Whether a paper survives one switch.  Combined, they are an AND: adding
 *  one narrows further, which is what a list of ticked boxes means. */
export const FILTER_TEST: Record<ListFilter, (d: Doc) => boolean> = {
  star: (d) => !!d.starred,
  unread: (d) => !d.read,
  nopdf: (d) => !d.localPdf,
  // `file_attached` is what Mendeley says about its own copy, so this is the
  // download queue: on the cloud, not yet on this disk
  cloud: (d) => !!d.file_attached && !d.localPdf,
  unfiled: (d) => !(d.folder_uuids ?? []).length
}
