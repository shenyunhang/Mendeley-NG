import type { SyncStatus, UpdateState } from '../../shared/types'
import { updateLine } from '../lib/updateText'
import { useI18n } from '../lib/i18nContext'

/**
 * Prose from the updater and from a sync, on a row of their own.
 *
 * The toolbar is one non-wrapping line whose far-end buttons must stay
 * reachable.  Putting sentences there made them the only shrinkable children:
 * two status lines competed for what was left and both lost their tail to an
 * ellipsis.  Here the whole width belongs to the text and it wraps, so the
 * reader never has to hover a tooltip to learn what a sync did.
 */
export default function StatusBar({
  upd,
  status
}: {
  upd: UpdateState | null
  status: SyncStatus | null
}) {
  const t = useI18n()
  const update = updateLine(upd, upd?.current ?? '')
  const sync = status?.message ?? ''
  if (!update && !sync) return null

  // The line itself is fully visible now; a tooltip is only worth having for
  // the release notes (or the raw error) that are not part of it.
  const detail = upd?.message && upd.message !== update ? upd.message : null

  return (
    <div className="status-bar" role="status" aria-live="polite">
      {update && (
        <div
          className={'status-line' + (upd?.phase === 'error' ? ' err' : ' update')}
          title={detail ?? undefined}
        >
          {t(update)}
        </div>
      )}
      {sync && <div className="status-line">{sync}</div>}
    </div>
  )
}
