import { DEFAULT_LANGUAGE, type Language } from '../../shared/types'

/**
 * Interface translation, with the Chinese text already in the UI as the key.
 *
 * That choice is deliberate. Chinese mode returns the key byte-for-byte, so
 * the whole existing interface and the smoke run's Chinese DOM assertions
 * keep working without a second set of labels. English mode looks the string
 * up; a label not translated yet stays Chinese instead of turning into a
 * blank button, which lets the dictionary grow one screen at a time.
 *
 * Only the interface is translated. Paper titles, authors, notes, folder
 * names and everything else that came from the library are the reader's data
 * and never pass through here.
 */
export const LANGUAGES: readonly Language[] = ['zh', 'en']

/** Language names are written in their own language, so the choice is legible
 *  even when the rest of the sheet is in the language being left behind. */
export const LANGUAGE_LABEL: Record<Language, string> = {
  zh: '中文',
  en: 'English'
}

export type Translator = (
  text: string,
  vars?: Record<string, string | number>
) => string

/** `{name}` placeholders keep dynamic sentences in the dictionary too, rather
 *  than splitting them into fragments that cannot be translated as a whole. */
function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  )
}

const EN: Record<string, string> = {
  // Settings: appearance
  '设置': 'Settings',
  '外观': 'Appearance',
  '主题': 'Theme',
  '深色': 'Dark',
  '浅色': 'Light',
  '语言': 'Language',
  '字号': 'Font size',
  '缩小界面字号': 'Decrease interface font size',
  '放大界面字号': 'Increase interface font size',
  '只影响界面，不影响 PDF 的清晰度': 'Changes the interface only, not how sharp the PDF is',
  // Settings: files
  '文件': 'Files',
  'PDF 目录': 'PDF folder',
  '未设置': 'Not set',
  '选择…': 'Choose…',
  '命名模板': 'Name template',
  '修改…': 'Edit…',
  '引文样式': 'Citation style',
  '作者（年份）': 'Author (year)',
  '全部作者': 'All authors',
  '编号': 'Numbered',
  '完整条目': 'Full entry',
  'BibTeX key': 'BibTeX key',
  'BibTeX 条目': 'BibTeX entry',
  '可用': 'Available',
  // Settings: sync
  '同步': 'Sync',
  '启动时': 'On start-up',
  '打开软件时自动同步一次': 'Sync once when the app opens',
  '只拉增量，失败不出声；关掉就只有点「同步云端」时才同步。':
    'Pulls only changes and stays quiet on failure; with this off, only the Sync button syncs.',
  '同步时': 'When syncing',
  '把云端有、本地没有的 PDF 一起下载下来': 'Also download PDFs the cloud has and this disk does not',
  '点「同步云端」或「全量」之后在后台三路并发下载，可随时停止；启动时的静默同步不下载，免得每次开机都占带宽。':
    'A manual or full sync downloads three files at a time in the background and can be stopped; the quiet start-up sync does not download, so opening the app does not use bandwidth.',
  // Settings: full text
  '全文检索': 'Full-text search',
  '每篇索引页数': 'Pages indexed per paper',
  '已索引 {indexed} 篇，每篇前 {pages} 页；改动后需要重建':
    '{indexed} papers indexed, {pages} pages each; changing this rebuilds the index',
  '还没建索引；改动后下次建索引生效': 'No index yet; the change takes effect on the next build',
  '页数越多越全，索引也越大。每篇前 3 页约 60 MB，全文约 293 MB。':
    'More pages find more, and cost more space. The first 3 pages of each paper take about 60 MB; all pages about 293 MB.',
  // Settings: about
  '关于': 'About',
  'Mendeley Desktop 1.19.8 的替代品，本地优先，高 DPI 原生正常。':
    'A replacement for Mendeley Desktop 1.19.8. Local first, and correct on high-DPI screens.',
  '完成': 'Done',
  '当前 {version}': 'Current {version}',
  '当前 {version}。从 GitHub Releases 拉取最新版本':
    'Current {version}. Check GitHub Releases for the newest build',
  '下载 {version}': 'Download {version}',
  '下载中 {percent}%': 'Downloading {percent}%',
  '重启并安装': 'Restart and install',
  '检查更新': 'Check for updates',
  '检查中…': 'Checking…',
  // Toolbar and menus
  '查重': 'Find duplicates',
  '全部标注': 'All annotations',
  '回收站': 'Trash',
  '保存搜索': 'Save search',
  '撤销': 'Undo',
  '撤销：{label}': 'Undo: {label}',
  '全量同步': 'Full sync',
  '切到深色主题': 'Switch to dark theme',
  '切到浅色主题': 'Switch to light theme',
  '{filtered} / {total} 篇': '{filtered} / {total} papers',
  '导入文件…': 'Import files…',
  '按标识符添加…': 'Add by identifier…',
  '设置…': 'Settings…',
  '导入 token…': 'Import token…',
  '更新到 {version}': 'Update to {version}',
  '项目主页 ↗': 'Project page ↗',
  '阅读': 'Read',
  '同步中…': 'Syncing…',
  '同步云端': 'Sync',
  '导出': 'Export',
  '导入': 'Import',
  '更多': 'More',
  '筛选': 'Filter',
  '排序': 'Sort',
  '列': 'Columns',
  '清空搜索': 'Clear search',
  '全文': 'Full text',
  '复制引文': 'Copy citation',
  '笔记（Markdown）': 'Notes (Markdown)',
  '标注（Markdown）': 'Annotations (Markdown)',
  '带走整个库…': 'Take the whole library…',
  '带走这 {n} 篇…': 'Take these {n} papers…',
  'BibTeX': 'BibTeX',
  'RIS': 'RIS',
  'EndNote XML': 'EndNote XML',
  'Markdown': 'Markdown',
  '搜索范围': 'Search scope',
  // Filter, sort and column cards
  '星标': 'Starred',
  '未读': 'Unread',
  '没有本地 PDF': 'No local PDF',
  '云端有本地没有': 'On cloud, not on disk',
  '未归入文件夹': 'Not in a folder',
  '全部清除': 'Clear all',
  '关闭': 'Close',
  '保存为视图…': 'Save as view…',
  '恢复默认': 'Restore defaults',
  '视图': 'Views',
  '上移': 'Move up',
  '下移': 'Move down',
  '删除这个视图': 'Delete this view',
  '按{label}排': 'Sort by {label}',
  // Table, tree, search results
  '没有匹配的文献': 'No matching papers',
  '没有匹配的文件夹': 'No matching folders',
  '全部文献': 'All papers',
  '保存的搜索': 'Saved searches',
  '筛选文件夹': 'Filter folders',
  '此列': 'this column',
  '取消星标': 'Remove star',
  '加星标': 'Add star',
  '相近': 'Near match',
  '取消选择': 'Clear selection',
  // Dialogs and row menu
  '删除': 'Delete',
  '确定': 'OK',
  '取消': 'Cancel',
  '{n} 条选中': '{n} selected',
  // Views: titles, actions and empty states
  '导入选中项': 'Import selected',
  '导入中…': 'Importing…',
  '重复': 'Duplicate',
  '(无标题)': '(Untitled)',
  '没有解析出条目': 'No entries found',
  '按标识符添加': 'Add by identifier',
  '添加选中项': 'Add selected',
  '添加中…': 'Adding…',
  '查询': 'Look up',
  '查询中…': 'Looking up…',
  '已在库中': 'Already in library',
  '{n} 条结果': '{n} results',
  '没查到，试试直接粘贴标题': 'Nothing found; try pasting a title',
  '返回库': 'Back to library',
  '恢复': 'Restore',
  '彻底删除': 'Delete permanently',
  '回收站是空的': 'Trash is empty',
  '返回列表': 'Back to list',
  '复制列表': 'Copy list',
  '复制': 'Copy',
  '没有匹配的标注': 'No matching annotations',
  '还没有任何标注。在阅读器里选中文字即可高亮。':
    'No annotations yet. Select text in the reader to highlight it.',
  '参考文献': 'References',
  '建索引': 'Build index',
  '索引中 {pct}%': 'Indexing {pct}%',
  '输入要找的词': 'Enter a word to find',
  '重建': 'Rebuild',
  '清空': 'Clear',
  '停止': 'Stop',
  '没有可索引的 PDF。': 'No PDFs to index.',
  '批量修改 {n} 条的字段': 'Edit fields of {n} papers',
  // Right pane and drag hint
  '详情': 'Details',
  '选中左侧一条文献查看详情或 PDF':
    'Select a paper on the left to see its details or PDF',
  '松手即导入 PDF': 'Drop to import PDF',
  '本地优先': 'Local first',
  // Shared labels rendered through t() (columns, sort, scope, citations)
  '标题': 'Title',
  '第一作者': 'First author',
  '年份': 'Year',
  '发表处': 'Source',
  '引用键': 'Citation key',
  '添加时间': 'Date added',
  '作者': 'Authors',
  '标签': 'Tags',
  '已读': 'Read',
  '类型': 'Type',
  '全部字段': 'All fields',
  '仅标题': 'Title only',
  '仅摘要': 'Abstract only',
  'PDF 正文': 'PDF text',
  // Small views and panels
  '字段': 'Field',
  '值': 'Value',
  '请选择…': 'Choose…',
  '应用中…': 'Applying…',
  '年份 / 发表处 / 类型': 'Year / Source / Type',
  '摘要': 'Abstract',
  '本地 PDF': 'Local PDF',
  '在文件夹中显示': 'Show in folder',
  '用系统程序打开': 'Open with default app',
  '打开 PDF': 'Open PDF',
  // App shell: panes, batch bar, right pane
  '文件夹': 'Folders',
  '文献': 'Papers',
  '已选 {n} 条': '{n} selected',
  '＋ 加入文件夹…': '＋ Add to folder…',
  '改目录': 'Change folder',
  '命名': 'Naming',
  '选择目录': 'Choose folder',
  '改字段…': 'Edit fields…',
  '移入回收站': 'Move to trash',
  '下载 PDF': 'Download PDF',
  '无标题': 'Untitled',
  '未设置 PDF 目录': 'No PDF folder set',
  '关掉这条提示': 'Dismiss this message',
  // New entries go above this line; a test checks every key is still in the UI.
}

export function makeTranslator(language: Language): Translator {
  return (text, vars) =>
    interpolate(language === 'en' ? (EN[text] ?? text) : text, vars)
}

/** For pure rules that need one translated string without a React context. */
export function translate(
  language: Language,
  text: string,
  vars?: Record<string, string | number>
): string {
  return makeTranslator(language)(text, vars)
}

export function translatedKeys(): string[] {
  return Object.keys(EN)
}

export { DEFAULT_LANGUAGE }
