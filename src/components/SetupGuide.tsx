/**
 * What to do before there is anything to look at.
 *
 * The toolbar has an "import token" button and a "sync" button, and for a
 * while that was thought to be enough.  It is not: getting a token means
 * registering an application at dev.mendeley.com, running a script and
 * pasting a code back into a terminal, and none of that is discoverable
 * from a button called 导入 token.  What stood in for instructions was a
 * README the person who needs it has not opened.
 *
 * So the steps are here, in the place where they are needed, and the guide
 * gets out of the way the moment there is a library to show.
 */
interface Props {
  /** which thing is missing; one at a time, because three problems at once
   *  is not an instruction */
  step: 'token' | 'sync'
  busy: boolean
  onImportToken: () => void
  onSync: () => void
  onDismiss: () => void
}

export default function SetupGuide({ step, busy, onImportToken, onSync, onDismiss }: Props) {
  return (
    <div className="pane pane-mid">
      <div className="setup">
        {step === 'token' ? (
          <>
            <h2>先接入你的 Mendeley 账号</h2>
            <p className="lede">
              这里读的是你 Mendeley 云端那一份库，所以要一个 token。Mendeley 的 API
              不提供通用的凭据——每个人得注册自己的应用，因此没有现成的 token 可以
              下载。走一遍就好，之后 refresh token 会自动续期，不用再来第二次。
            </p>
            <ol className="steps">
              <li>
                到 <b>dev.mendeley.com/myapps.html</b> 注册一个应用。
                Redirect URL 填 <code>http://localhost:8080/</code>。
                注册完会拿到 <code>client_id</code> 和 <code>client_secret</code>。
              </li>
              <li>
                在项目目录里跑
                <code>node scripts/get-token.mjs &lt;client_id&gt; &lt;client_secret&gt;</code>
                。脚本会打印一个授权地址，在浏览器里打开并同意，接着会跳到一个打不开的
                localhost 地址——<b>这是正常的</b>，那个地址不需要能访问。把地址栏里
                <code>?code=</code> 后面那一段复制下来粘回命令行。
              </li>
              <li>
                脚本会写出 <code>token.json</code>。点下面这个按钮选中它，会自动开始同步。
              </li>
            </ol>
            <div className="setup-actions">
              <button className="primary" disabled={busy} onClick={onImportToken}>
                {busy ? '同步中…' : '选择 token.json'}
              </button>
              <button onClick={onDismiss}>已经有库了，先看看本地</button>
            </div>
            <p className="foot">
              要是已经把 token 放好了，就不用导入：应用会自动在
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
