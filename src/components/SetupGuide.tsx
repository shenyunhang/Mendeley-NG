/**
 * What to do before there is anything to look at.
 *
 * The toolbar has an "import token" button and a "sync" button, and for a
 * while that was thought to be enough.  It is not: getting a token means
 * registering an application at dev.mendeley.com, and none of that is
 * discoverable from a button called 导入 token.
 *
 * It used to continue "running a script and pasting a code back into a
 * terminal".  Those two steps are gone: the app opens the authorization
 * window itself and catches the code on the way back, so what is left for
 * the reader to do is register an application, paste the two values it hands
 * out, and sign in once.  Registration cannot be removed — Mendeley has no
 * PKCE, and its implicit flow returns no refresh token — but that is one trip
 * to a web page rather than a trip to a terminal.
 */
import { useEffect, useState } from 'react'
import { OAUTH_REDIRECT } from '../../shared/types'
import { COPIED_FEEDBACK_VISIBLE_MS } from '../lib/timing'

interface Props {
  /** which thing is missing; one at a time, because three problems at once
   *  is not an instruction */
  step: 'token' | 'sync'
  busy: boolean
  /** resolves to a message to show next to the fields, or null on success */
  onAuthorize: (clientId: string, clientSecret: string) => Promise<string | null>
  onImportToken: () => void
  onSync: () => void
  onDismiss: () => void
}

export default function SetupGuide({
  step,
  busy,
  onAuthorize,
  onImportToken,
  onSync,
  onDismiss
}: Props) {
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), COPIED_FEEDBACK_VISIBLE_MS)
    return () => clearTimeout(t)
  }, [copied])

  const run = async () => {
    setErr(null)
    setRunning(true)
    try {
      const msg = await onAuthorize(id, secret)
      if (msg) setErr(msg)
    } catch (e) {
      setErr(String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="pane pane-mid">
      <div className="setup">
        {step === 'token' ? (
          <>
            <h2>先接入你的 Mendeley 账号</h2>
            {/**
             * Answered before it is asked.  Somebody told to go and register
             * an application at a developer portal reads "am I about to become
             * a developer", and while that question is open every step below
             * looks like one more unreasonable demand.  So the first thing on
             * the page is what this costs — once, two minutes, never again —
             * and the second is that it is form-filling, not programming.
             */}
            <p className="setup-once">
              <b>这一步只做一次，大约两分钟。</b>做完 token 会自己续期，
              你不会再回到这个页面，也不用再碰 dev.mendeley.com。
            </p>
            <p className="lede">
              这个程序要一把能读你库的钥匙，而 Mendeley 没有「给某个应用授权」这种按钮：
              它的做法是让你在 <b>dev.mendeley.com</b> 上登记一个名字。
              <b>这不是注册开发者账号，也不用写任何代码</b>——页面上只有两个框要填，
              填完它给你两串字符，粘到下面就行。
            </p>
            <ol className="steps">
              <li>
                到 <b>dev.mendeley.com/myapps.html</b> 注册一个应用，Redirect URL 填
                <code
                  className="copyable"
                  title={copied ? '已复制' : '点击复制'}
                  onClick={() => {
                    void window.api.copyText(OAUTH_REDIRECT)
                    setCopied(true)
                  }}
                >
                  {OAUTH_REDIRECT}
                </code>
                。注册完会拿到 <code>client_id</code> 和 <code>client_secret</code>。
              </li>
              <li>
                把这两个值填进下面，点「授权并接入」。会弹一个窗口让你登录并同意，
                同意完就好了——token 会自动放好，不用再回命令行。
              </li>
            </ol>
            <div className="setup-auth">
              <input
                className="setup-id"
                placeholder="client_id"
                title="注册应用页面上 Client ID 那一行"
                spellCheck={false}
                autoComplete="off"
                value={id}
                onChange={(e) => setId(e.target.value)}
              />
              {/* Not masked on purpose: it was in plain text on the page it was
                  copied from, and hiding it here only makes a paste look like
                  it failed. */}
              <input
                className="setup-id"
                placeholder="client_secret"
                title="注册应用页面上 Secret 那一行"
                spellCheck={false}
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              <button
                className="primary"
                disabled={busy || running || !id.trim() || !secret.trim()}
                onClick={() => void run()}
              >
                {running || busy ? '授权中…' : '授权并接入'}
              </button>
            </div>
            {err && <p className="setup-err">{err}</p>}
            <div className="setup-actions">
              <button onClick={onImportToken}>选择已有的 token.json</button>
              <button onClick={onDismiss}>已经有库了，先看看本地</button>
            </div>
            <p className="foot">
              为什么非要这一步：Mendeley 的 OAuth 没有 PKCE，implicit 流程又不给
              refresh token（access token 约一小时就过期），所以只有这条路能拿到一把
              不会一小时就失效的钥匙。
              <br />
              不想把 client_secret 粘进输入框，也可以在项目目录里跑
              <code>node scripts/get-token.mjs &lt;client_id&gt; &lt;client_secret&gt;</code>
              ——那条路会写出一个 token.json，用上面的按钮选中它就行。
              已经放好的 token 不用导入：应用会自动在
              <code>&lt;userData&gt;/token.json</code>、
              <code>&lt;userData&gt;/mendeley-token.json</code>，
              以及环境变量 <code>MENDELEY_TOKEN_PATH</code> 指向的位置找。
            </p>
          </>
        ) : (
          <>
            <h2>库还是空的</h2>
            <p className="lede">
              token 已经有了。同步一次，把云端的文献拉到本地缓存——之后每次启动只要
              几秒，只有第一次要把整个库搬过来。
            </p>
            <div className="setup-actions">
              <button className="primary" disabled={busy} onClick={onSync}>
                {busy ? '同步中…' : '同步云端'}
              </button>
              <button onClick={onDismiss}>以后再说</button>
            </div>
            <p className="foot">
              也可以先拖几个 PDF 进来，或者用「按标识符添加」按 DOI / arXiv id 建条目——
              这些不需要先同步。
            </p>
          </>
        )}
      </div>
    </div>
  )
}
