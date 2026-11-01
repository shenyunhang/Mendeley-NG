import { useState } from 'react'
import type { FtStatus, UpdateState } from '../../shared/types'
import { DEFAULT_FT_PAGES, DEFAULT_PDF_TEMPLATE } from '../../shared/types'
import logoUrl from '../../assets/logo.svg'

/**
 * What the update line says, given the state and the version that is running.
 *
 * Both numbers are named in every line that has a second number to name.
 * "有新版本" without saying which one, or "已是最新" without saying what is
 * being called latest, both leave the reader unable to answer the question
 * they actually came here with: is the thing I am running the thing that was
 * fixed?
 */
function updLine(upd: UpdateState | null | undefined, current: string): string | null {
  const p = upd?.phase
  if (!upd || !p || p === 'idle') return null
  if (p === 'checking') return `正在检查…（当前 ${current}）`
  if (p === 'available') return `有新版本 ${upd.version ?? ''}（当前 ${current}）`
  if (p === 'not-available') return `已是最新版本（当前 ${current}）`
  if (p === 'downloading') return `正在下载 ${upd.version ?? ''} ${upd.percent ?? 0}%`
  if (p === 'downloaded') return `${upd.version ?? ''} 已下载，重启后安装（当前 ${current}）`
  if (p === 'error') return `检查更新失败：${upd.message ?? '未知错误'}`
  return upd.message ?? null
}

interface Props {
  theme: 'dark' | 'light'
  fontSize: number
  pdfDir: string
  nameTemplate: string
  citeStyle: string
  /** Full-text index state, shown rather than described: whether the index
   *  exists is the one thing that decides whether the page budget matters. */
  ft: FtStatus | null
  ftPages: number
  version: string
  /** What the updater is doing, so the two versions can be compared here
   *  rather than in a toolbar line that vanishes. */
  upd?: UpdateState | null
  onCheckUpdate?: () => void
  onDownloadUpdate?: () => void
  onInstallUpdate?: () => void
  onClose: () => void
  onTheme: (t: 'dark' | 'light') => void
  onFont: (n: number) => void
  onPickPdfDir: () => void
  onNameTemplate: () => void
  onCiteStyle: (s: string) => void
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
  fontSize,
  pdfDir,
  nameTemplate,
  citeStyle,
  ft,
  ftPages,
  version,
  upd,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
  onClose,
  onTheme,
  onFont,
  onPickPdfDir,
  onNameTemplate,
  onCiteStyle,
  onFtPages
}: Props) {
  // the page budget is applied on blur rather than on every keystroke: each
  // change drops the index, and an index dropped per digit is not a setting
  const [pages, setPages] = useState(String(ftPages))

  const commit = () => {
    const n = Number(pages)
    if (!Number.isFinite(n) || n < 1) {
      setPages(String(DEFAULT_FT_PAGES))
      onFtPages(DEFAULT_FT_PAGES)
      return
    }
    onFtPages(Math.min(50, Math.floor(n)))
  }

  return (
    <div className="modal-veil" onMouseDown={onClose}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">设置</div>

        <div className="set-sec">外观</div>
        <div className="set-row">
          <span className="set-key">主题</span>
          <button
            className={theme === 'dark' ? 'primary' : ''}
            onClick={() => onTheme('dark')}
          >
            深色
          </button>
          <button
            className={theme === 'light' ? 'primary' : ''}
            onClick={() => onTheme('light')}
          >
            浅色
          </button>
        </div>
        <div className="set-row">
          <span className="set-key">字号</span>
          <button onClick={() => onFont(fontSize - 1)} title="缩小界面字号">
            A−
          </button>
          <span className="set-val">{fontSize}px</span>
          <button onClick={() => onFont(fontSize + 1)} title="放大界面字号">
            A＋
          </button>
          <span className="set-note">只影响界面，不影响 PDF 的清晰度</span>
        </div>

        <div className="set-sec">文件</div>
        <div className="set-row">
          <span className="set-key">PDF 目录</span>
          <span className="set-path" title={pdfDir || '未设置'}>
            {pdfDir || '未设置'}
          </span>
          <button onClick={onPickPdfDir}>选择…</button>
        </div>
        <div className="set-row">
          <span className="set-key">命名模板</span>
          <span className="set-path">{nameTemplate || DEFAULT_PDF_TEMPLATE}</span>
          <button onClick={onNameTemplate}>修改…</button>
        </div>
        <div className="set-note">
          可用 {'{title} {year} {authors} {journal} {key} {type} {doi}'}
        </div>
        <div className="set-row">
          <span className="set-key">引文样式</span>
          <select value={citeStyle} onChange={(e) => onCiteStyle(e.target.value)}>
            <option value="author-year">作者（年份）</option>
            <option value="authors">全部作者</option>
            <option value="numeric">编号</option>
            <option value="full">完整条目</option>
            <option value="key">BibTeX key</option>
            <option value="bibtex">BibTeX 条目</option>
          </select>
        </div>

        <div className="set-sec">全文检索</div>
        <div className="set-row">
          <span className="set-key">每篇索引页数</span>
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
              ? `已索引 ${ft.indexed} 篇，每篇前 ${ft.pages ?? pages} 页；改动后需要重建`
              : '还没建索引；改动后下次建索引生效'}
          </span>
        </div>
        <div className="set-note">
          页数越多越全，索引也越大。每篇前 3 页约 60 MB，全文约 293 MB。
        </div>

        <div className="set-sec">关于</div>
        <div className="about">
          <img className="about-logo" src={logoUrl} alt="" width={56} height={56} />
          <div>
            <div>Mendeley NG {version}</div>
            <div className="set-note">
              Mendeley Desktop 1.19.8 的替代品，本地优先，高 DPI 原生正常。
            </div>
            {/* Both numbers, side by side.  A reader who was told a build is
                fixed needs to know whether the version in front of them is
                the fixed one or the one they reported, and that is a question
                about two versions, not one. */}
            <div className="about-upd">
              {updLine(upd, version) ? (
                <span className={upd?.phase === 'error' ? 'upd-line err' : 'upd-line'}>
                  {updLine(upd, version)}
                </span>
              ) : (
                <span className="upd-line">当前 {version}</span>
              )}
              <button
                disabled={upd?.phase === 'checking' || upd?.phase === 'downloading'}
                title={`当前 ${version}。从 GitHub Releases 拉取最新版本`}
                onClick={() => {
                  if (upd?.phase === 'available') onDownloadUpdate?.()
                  else if (upd?.phase === 'downloaded') onInstallUpdate?.()
                  else onCheckUpdate?.()
                }}
              >
                {upd?.phase === 'available'
                  ? `下载 ${upd.version ?? ''}`
                  : upd?.phase === 'downloaded'
                    ? '重启并安装'
                    : upd?.phase === 'checking'
                      ? '检查中…'
                      : upd?.phase === 'downloading'
                        ? `下载中 ${upd.percent ?? 0}%`
                        : '检查更新'}
              </button>
            </div>
          </div>
        </div>

        <div className="modal-acts">
          <button className="primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
