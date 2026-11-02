/**
 * What a failed sync means.
 *
 * The app is local-first on purpose: reading, searching, marking and
 * exporting never touch the network, and only three things ever do.  But the
 * message shown when one of those three failed used to be the same for every
 * cause, and it advised importing a token — which is wrong advice for the one
 * failure a reader is most likely to meet, and which says nothing about the
 * library still sitting on the screen, fully usable, in front of them.
 *
 * So the failure is read before it is reported.  The distinction that matters
 * is not technical but practical: is this something the reader can fix (their
 * credential expired, so go and authorise again), something they cannot (the
 * network, or Mendeley's API, is not answering), or something neither.  And
 * in all three cases the second half of the message is the same, because it
 * is the half the reader is actually worried about: their papers are still
 * here, and this program was built so that they would be.
 */

export type SyncFailureKind = 'auth' | 'network' | 'other'

/** Node reports an unreachable host as a bare `fetch failed`, with the real
 *  reason one level down in `cause`; the string that reaches the renderer is
 *  whichever of the two survived being turned into a message. */
const NETWORK = [
  'fetch failed',
  'getaddrinfo',
  'enotfound',
  'eai_again',
  'econnrefused',
  'econnreset',
  'etimedout',
  'ehostunreach',
  'enetunreach',
  'network',
  'socket',
  'offline'
]

const AUTH = ['no_token', '401', '403', 'refresh', 're-authorisation', 'unauthorised', 'unauthorized']

/**
 * The message to show when a sync did not happen.
 *
 * `docs` is how many papers are on screen either way — the number that turns
 * "同步失败" from a verdict on the program into a fact about one of its three
 * network calls.
 */
export function describeSyncFailure(
  msg: string,
  docs: number
): { kind: SyncFailureKind; text: string } {
  const low = String(msg ?? '').toLowerCase()
  const here = docs > 0 ? `本地这 ${docs} 篇照常能用` : '本地那份照常能用'
  const kind: SyncFailureKind = AUTH.some((k) => low.includes(k))
    ? 'auth'
    : NETWORK.some((k) => low.includes(k))
      ? 'network'
      : 'other'
  if (kind === 'auth') {
    return {
      kind,
      text:
        `接入过期了：${msg}。重新授权一次就好（重新填 client_id / client_secret，` +
        `或导入一个 token.json）。${here}，只是新的改动暂时同步不上去。`
    }
  }
  if (kind === 'network') {
    return {
      kind,
      text:
        `连不上 Mendeley：${msg}。这是网络的事，不是库的事——${here}，` +
        `读、搜、标注、导出都不经过网络，只有同步和下载 PDF 需要它。` +
        `就算 Mendeley 的 API 从此不再可用，本地这份也仍然是完整的，随时可以「带走整个库」。`
    }
  }
  return { kind, text: `同步失败：${msg}　${here}，只是这一次的同步没成。` }
}
