import { useEffect, useRef, useState } from 'react'
import type { FtStatus, Language, UpdateState } from '../../shared/types'
import { DEFAULT_PDF_TEMPLATE } from '../../shared/types'
import { commitPageBudget } from '../lib/pageBudgetCommit'
import { updateLine } from '../lib/updateText'
import { useI18n } from '../lib/i18nContext'
import logoUrl from '../../assets/logo.svg'

interface Props {
  theme: 'dark' | 'light'
  language: Language
  fontSize: number
  pdfDir: string
  nameTemplate: string
  citeStyle: string
  /** Whether a pull happens on its own at start-up.  Off still leaves the
   *  同步云端 button, and saying so is the point: a switch whose other
   *  position nobody can describe is a switch nobody can decide about. */
  syncOnStart: boolean
  /** Whether a manual pull also brings down the PDFs this disk is missing. */
  syncPdfsOnSync: boolean
  /** Full-text index state, shown rather than described: whether the index
   *  exists is the one thing that decides whether the page budget matters. */
  ft: FtStatus | null
  ftPages: number
  version: string
  /** The section to open on, when something other than the settings sheet
   *  itself sent the reader here.  A sheet that always opens at the top makes
   *  "去设置里改" into a hunt: the row is four screens down a scrolling box,
   *  and a reader who was told one number is the answer will not recognise it
   *  when they finally scroll past it. */
  focus?: string | null
  /** What the updater is doing, so the two versions can be compared here
   *  rather than in a toolbar line that vanishes. */
  upd?: UpdateState | null
  onCheckUpdate?: () => void
  onDownloadUpdate?: () => void
  onInstallUpdate?: () => void
  onClose: () => void
  onTheme: (t: 'dark' | 'light') => void
  onLanguage: (language: Language) => void
  onFont: (n: number) => void
  onPickPdfDir: () => void
  onNameTemplate: () => void
  onCiteStyle: (s: string) => void
  onSyncOnStart: (v: boolean) => void
  onSyncPdfsOnSync: (v: boolean) => void
  onFtPages: (n: number) => void
}

/**
 * Everything the app remembers, in one place.
 *
 * It used to be spread over four corners of the toolbar — the theme behind an
 * icon, the font behind two A's, the PDF directory and the naming template
 * behind two more buttons in the pane header — which meant a new user had to
 * be told where to look rather than being able to look.
 */
export default function Settings({
  theme,
  language,
  fontSize,
  pdfDir,
  nameTemplate,
  citeStyle,
  syncOnStart,
  syncPdfsOnSync,
  ft,
  ftPages,
  version,
  focus,
  upd,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
  onClose,
  onTheme,
  onLanguage,
  onFont,
  onPickPdfDir,
  onNameTemplate,
  onCiteStyle,
  onSyncOnStart,
  onSyncPdfsOnSync,
  onFtPages
}: Props) {
  // the page budget is applied on blur rather than on every keystroke: each
  // change drops the index, and an index dropped per digit is not a setting
  const [pages, setPages] = useState(String(ftPages))
  const sheet = useRef<HTMLDivElement>(null)
  const t = useI18n()

  // Scrolls to the section that was asked for.  It cannot be done by id: the
  // sections are headings in a scrolling box and there is nowhere to put an
  // anchor that does not move the layout.  Read from the live box rather than
  // from a map of names, so a section that is renamed cannot leave the reader
  // at the top of a sheet that claims to have taken them somewhere.
  useEffect(() => {
    if (!focus) return
    // The caller names the section in Chinese, which is also the translation
    // key. Translate that name too, or switching language would leave a
    // "go to settings" jump looking for a heading that is no longer there.
    const sec = [...(sheet.current?.querySelectorAll('.set-sec') ?? [])].find(
      (s) => (s.textContent ?? '').trim() === t(focus)
    )
    sec?.scrollIntoView({ block: 'start' })
  }, [focus, t])

  const commit = () => {
    const { shown, applied } = commitPageBudget(pages)
    setPages(shown)
    onFtPages(applied)
  }

  return (
    <div className="modal-veil" onMouseDown={onClose}>
      <div
        className="modal settings"
        ref={sheet}
        data-focus={focus ?? undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">{t('设置')}</div>

        <div className="set-sec">{t('外观')}</div>
        <div className="set-row">
          <span className="set-key">{t('主题')}</span>
          <button
            className={theme === 'dark' ? 'primary' : ''}
            onClick={() => onTheme('dark')}
          >
            {t('深色')}
          </button>
          <button
            className={theme === 'light' ? 'primary' : ''}
            onClick={() => onTheme('light')}
          >
            {t('浅色')}
          </button>
        </div>
        <div className="set-row" data-lang-row>
          <span className="set-key">{t('语言')}</span>
          <button
            data-lang="zh"
            className={language === 'zh' ? 'primary' : ''}
            onClick={() => onLanguage('zh')}
          >
            中文
          </button>
          <button
            data-lang="en"
            className={language === 'en' ? 'primary' : ''}
            onClick={() => onLanguage('en')}
          >
            English
          </button>
        </div>
        <div className="set-row">
          <span className="set-key">{t('字号')}</span>
          <button onClick={() => onFont(fontSize - 1)} title={t('缩小界面字号')}>
            A−
          </button>
          <span className="set-val">{fontSize}px</span>
          <button onClick={() => onFont(fontSize + 1)} title={t('放大界面字号')}>
            A＋
          </button>
          <span className="set-note">{t('只影响界面，不影响 PDF 的清晰度')}</span>
        </div>

        <div className="set-sec">{t('文件')}</div>
        <div className="set-row">
          <span className="set-key">{t('PDF 目录')}</span>
          <span className="set-path" title={pdfDir || t('未设置')}>
            {pdfDir || t('未设置')}
          </span>
          <button onClick={onPickPdfDir}>{t('选择…')}</button>
        </div>
        <div className="set-row">
          <span className="set-key">{t('命名模板')}</span>
          <span className="set-path" title={nameTemplate || DEFAULT_PDF_TEMPLATE}>
            {nameTemplate || DEFAULT_PDF_TEMPLATE}
          </span>
          <button onClick={onNameTemplate}>{t('修改…')}</button>
        </div>
        <div className="set-note">
          {t('可用')} {'{title} {year} {authors} {journal} {key} {type} {doi}'}
        </div>
        <div className="set-row">
          <span className="set-key">{t('引文样式')}</span>
          <select value={citeStyle} onChange={(e) => onCiteStyle(e.target.value)}>
            <option value="author-year">{t('作者（年份）')}</option>
            <option value="authors">{t('全部作者')}</option>
            <option value="numeric">{t('编号')}</option>
            <option value="full">{t('完整条目')}</option>
            <option value="key">{t('BibTeX key')}</option>
            <option value="bibtex">{t('BibTeX 条目')}</option>
          </select>
        </div>

        <div className="set-sec">{t('同步')}</div>
        <div className="set-row">
          <span className="set-key">{t('启动时')}</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={syncOnStart}
              onChange={(e) => onSyncOnStart(e.target.checked)}
            />
            {t('打开软件时自动同步一次')}
          </label>
        </div>
        <div className="set-note">
          {t('只拉增量，失败不出声；关掉就只有点「同步云端」时才同步。')}
        </div>
        <div className="set-row">
          <span className="set-key">{t('同步时')}</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={syncPdfsOnSync}
              onChange={(e) => onSyncPdfsOnSync(e.target.checked)}
            />
            {t('把云端有、本地没有的 PDF 一起下载下来')}
          </label>
        </div>
        <div className="set-note">
          {t('点「同步云端」或「全量」之后在后台三路并发下载，可随时停止；启动时的静默同步不下载，免得每次开机都占带宽。')}
        </div>

        <div className="set-sec">{t('全文检索')}</div>
        <div className="set-row">
          <span className="set-key">{t('每篇索引页数')}</span>
          <input
            style={{ width: 64 }}
            value={pages}
            onChange={(e) => setPages(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
            }}
          />
          <span className="set-note">
            {ft?.indexed
              ? t('已索引 {indexed} 篇，每篇前 {pages} 页；改动后需要重建', {
                  indexed: ft.indexed,
                  pages: ft.pages ?? pages
                })
              : t('还没建索引；改动后下次建索引生效')}
          </span>
        </div>
        <div className="set-note">
          {t('页数越多越全，索引也越大。每篇前 3 页约 60 MB，全文约 293 MB。')}
        </div>

        <div className="set-sec">{t('关于')}</div>
        <div className="about">
          <img className="about-logo" src={logoUrl} alt="" width={56} height={56} />
          <div>
            <div>Mendeley NG {version}</div>
            <div className="set-note">
              {t('Mendeley Desktop 1.19.8 的替代品，本地优先，高 DPI 原生正常。')}
            </div>
            {/* Both numbers, side by side.  A reader who was told a build is
                fixed needs to know whether the version in front of them is
                the fixed one or the one they reported, and that is a question
                about two versions, not one. */}
            <div className="about-upd">
              {updateLine(upd, version) ? (
                <span className={upd?.phase === 'error' ? 'upd-line err' : 'upd-line'}>
                  {t(updateLine(upd, version) ?? '')}
                </span>
              ) : (
                <span className="upd-line">{t('当前 {version}', { version })}</span>
              )}
              <button
                disabled={upd?.phase === 'checking' || upd?.phase === 'downloading'}
                title={t('当前 {version}。从 GitHub Releases 拉取最新版本', { version })}
                onClick={() => {
                  if (upd?.phase === 'available') onDownloadUpdate?.()
                  else if (upd?.phase === 'downloaded') onInstallUpdate?.()
                  else onCheckUpdate?.()
                }}
              >
                {upd?.phase === 'available'
                  ? t('下载 {version}', { version: upd.version ?? '' })
                  : upd?.phase === 'downloaded'
                    ? t('重启并安装')
                    : upd?.phase === 'checking'
                      ? t('检查中…')
                      : upd?.phase === 'downloading'
                        ? t('下载中 {percent}%', { percent: upd.percent ?? 0 })
                        : t('检查更新')}
              </button>
            </div>
          </div>
        </div>

        <div className="modal-acts">
          <button className="primary" onClick={onClose}>
            {t('完成')}
          </button>
        </div>
      </div>
    </div>
  )
}
