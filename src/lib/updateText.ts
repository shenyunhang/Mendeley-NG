import type { UpdateState } from '../../shared/types'

/**
 * The one place that turns an UpdateState into the line of Chinese the reader
 * sees.  The toolbar and the settings panel used to keep two copies of this
 * mapping and they drifted apart ("检查更新…" here, "正在检查…" there; "更新失败"
 * here, "检查更新失败" there).  One copy means a phase added to the type has
 * one wording to write, and both views always say the same thing about the
 * same state.
 *
 * `current` is the version that is running.  It is a plain argument rather
 * than read off `upd.current`, so the toolbar (which takes the number from the
 * state) and the settings panel (which is handed the app version) can each
 * supply the number they already had.  Nothing here imports React: it is a
 * pure function of its two inputs, and the caller owns the colour.
 */

/** The single phase enumeration, taken from shared/types.ts. */
export type UpdatePhase = UpdateState['phase']

type LineFn = (upd: UpdateState, current: string) => string | null

/** Wording for every phase, once.  `idle` says nothing, which both views
 *  honour by rendering no update line at all. */
const UPDATE_LINE: Record<UpdatePhase, LineFn> = {
  idle: () => null,
  checking: (_upd, current) =>
    current ? `检查更新…（当前 ${current}）` : '检查更新…',
  available: (upd, current) =>
    current && upd.version
      ? `新版本 ${upd.version}（当前 ${current}），开始下载`
      : `发现新版本 ${upd.version ?? ''}，开始下载`,
  'not-available': (_upd, current) =>
    current ? `已是最新版本（当前 ${current}）` : '已是最新版本',
  downloading: (upd) =>
    upd.version
      ? `下载 ${upd.version} ${upd.percent ?? 0}%`
      : `下载中 ${upd.percent ?? 0}%`,
  downloaded: (upd, current) =>
    upd.version && current
      ? `${upd.version} 已就绪（当前 ${current}），重启安装`
      : upd.version
        ? `${upd.version} 已就绪，重启安装`
        : '安装并重启…',
  error: (upd) => `更新失败：${upd.message ?? '未知错误'}`,
  unsupported: (upd) => upd.message ?? '当前环境不支持更新'
}

/** The line to show, or null when the phase has nothing to say. */
export function updateLine(
  upd: UpdateState | null | undefined,
  current: string
): string | null {
  if (!upd) return null
  return UPDATE_LINE[upd.phase](upd, current)
}
