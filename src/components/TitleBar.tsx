import logoUrl from '../../assets/logo.svg?url'

/**
 * The Windows frame is hidden, so this strip is both the window's identity and
 * its drag handle.  Chromium draws the three native window controls over the
 * far right of the same 34px band; that width stays empty.  Nothing here is a
 * command -- the toolbar one row below already owns every action, and a
 * duplicate menu was the thing that made the old chrome look wrong.
 */
export default function TitleBar() {
  return (
    <div className="title-bar">
      <img className="title-bar-mark" src={logoUrl} alt="" draggable={false} />
      <span className="title-bar-name">Mendeley NG</span>
      <span className="title-bar-sep" />
      <span className="title-bar-tag">本地优先</span>
      <span className="title-bar-spacer" />
      <span className="title-bar-controls" />
    </div>
  )
}
