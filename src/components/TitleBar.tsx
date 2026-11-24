import logoUrl from '../../assets/logo.svg?url'

/**
 * The window's identity, now the first item of the one chrome row rather than
 * a band of its own.  Chromium draws the three native controls over the far
 * right of the same row; `.title-bar-controls` at the far end reserves their
 * width.  This group and the empty gaps are the drag handles -- the buttons
 * are not, which is why the drag region lives on these spans only.
 */
export default function TitleBar() {
  return (
    <div className="title-bar-identity">
      <img className="title-bar-mark" src={logoUrl} alt="" draggable={false} />
      <span className="title-bar-name">Mendeley NG</span>
      <span className="title-bar-sep" />
      <span className="title-bar-tag">本地优先</span>
    </div>
  )
}

/** Empty space at the right of the row for the OS-drawn window controls.
 *  Kept beside the identity component because the two are one decision:
 *  where the hidden frame's chrome is allowed to sit. */
export function TitleBarControls() {
  return <span className="title-bar-controls" />
}
