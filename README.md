# Mendeley NG

替代 Mendeley Desktop 1.19.8 的文献管理器。Electron + React + pdf.js，直接读写你的
Mendeley 云端库。

> 要接手开发，看 [HANDOFF.md](HANDOFF.md)：现状、架构、API 的坑、待办都在里面。

写它的唯一理由：1.19.8 是 Qt 5.10.1 编译的，它声明自己感知 DPI 但支持不完整，
按物理像素渲染、不吃系统缩放倍率，所以在 4K 屏上字只有别的程序一半大；
改注册表强制 `DPIUNAWARE` 又会换来整窗模糊。Chromium 则是按系统 scale factor
缩放 CSS 像素的，天然就是清晰的，不需要任何 DPI 补丁。

## 安装与运行

```bash
npm install
npm run build      # 产出 out/
npm start          # 启动
npm run dev        # 热重载开发
npm run typecheck  # main/preload 与 renderer 双侧类型检查
npm run dist       # 打包 Windows NSIS 安装包
```

`npm start` 走的是 `scripts/start.mjs` 而不是直接 `electron .`：某些 shell
（Electron 系的 IDE 终端就是）会导出 `ELECTRON_RUN_AS_NODE=1`，带着它启动
electron.exe 会退化成纯 Node，`require('electron')` 返回的是二进制路径字符串，
主进程直接死在 `app.whenReady()`。启动脚本把这个变量剔掉，从哪儿跑都能起来。

## 获取 token（首次使用必读）

Mendeley 的 API 用 OAuth 2.0，而这个项目没有内置 client credential——
**每个人都要注册自己的应用**，所以没有现成的 token 可下载。走一遍就好，之后
refresh token 会自动续期，不用再来第二次。

### 1. 注册应用

打开 <https://dev.mendeley.com/myapps.html> 注册一个应用。Redirect URL 填：

```
http://localhost:8080/
```

注册完会拿到 `client_id` 和 `client_secret`。

### 2. 换 token

```bash
node scripts/get-token.mjs <client_id> <client_secret>
```

脚本会打印一个授权地址。在浏览器里打开、登录后同意授权，浏览器接着会跳到一个
打不开的 `localhost` 地址——**这是正常的**，那个地址根本不需要能访问。
把地址栏里 `?code=` 后面那一段复制下来，粘回命令行。

成功后会在项目根目录写出 `token.json`（已在 `.gitignore` 里，不会被提交）。

<details>
<summary>想手动做的话</summary>

授权地址：

```
https://api.mendeley.com/oauth/authorize?client_id=<ID>&redirect_uri=http://localhost:8080/&response_type=code&scope=all
```

拿到 `code` 后：

```bash
curl -X POST https://api.mendeley.com/oauth/token \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
  -u "<client_id>:<client_secret>" \
  -d "grant_type=authorization_code" \
  -d "code=<CODE>" \
  -d "redirect_uri=http://localhost:8080/"
```

`-A` 不能省：`api.mendeley.com` 前面的 Cloudflare 会对不像浏览器的请求返回
error 1010，`/oauth/token` 也一样。把响应里的 `access_token` / `refresh_token`
连同 `client_id` / `client_secret` 一起存成 `token.json`。

</details>

### 3. 导入

启动应用，点工具栏**导入 token**，选中刚才那个 `token.json`，会自动开始同步。

应用也会在下述位置自动找 token，找到了就不用导入：

- `<userData>/token.json`
- `<userData>/mendeley-token.json`
- 环境变量 `MENDELEY_TOKEN_PATH` 指向的路径

`<userData>` 在 Windows 上是 `%APPDATA%\mendeley-ng`。

### 4. 本地 PDF

默认 PDF 目录是 Mendeley Desktop 自己的 `%LOCALAPPDATA%\Mendeley Ltd\Mendeley Desktop\Downloaded`，
可在中间栏**改目录**更换。文件名按 `作者 - 年份 - 标题.pdf` 解析后与云端条目匹配。

全量同步需要几分钟，取决于库的规模与 Mendeley 那边的响应速度。

## 它能做什么

| 功能 | 说明 |
| --- | --- |
| 浏览 | 三栏：文件夹树 / 文献列表 / 详情或 PDF。列表是虚拟滚动，几千行也不卡 |
| 搜索 | Ctrl+F，覆盖标题、作者、发表处、citation key、DOI |
| 排序 | 点列头切换升降序 |
| 读 PDF | pdf.js，按 `devicePixelRatio` 出后备缓冲，高 DPI 下不虚 |
| 改元数据 | 右侧详情面板直接编辑，PATCH 回 Mendeley 云端 |
| 归文件夹 | 把行拖到左侧文件夹即可加入；详情面板可勾选移出 |
| 导出 | BibTeX / RIS，可只导出当前筛选结果或单条 |
| 字号 | 工具栏 A−/A+，或 Ctrl+− / Ctrl+=。整站 rem，一个旋钮全跟着变 |

## 结构

```
electron/main/mendeley.ts   Mendeley REST 客户端
electron/main/store.ts      本地缓存：文献、文件夹、标注、配置
electron/main/pdfindex.ts   把 "作者 - 年份 - 标题.pdf" 匹配回文献
electron/main/index.ts      主进程，IPC，mendeley:// 协议
electron/preload/index.ts   contextBridge，只暴露白名单方法
src/                        renderer：React + 虚拟滚动 + pdf.js
shared/types.ts             三端共享的类型
scripts/start.mjs           启动器
scripts/get-token.mjs       OAuth 授权码流程，产出 token.json
scripts/check-api.mjs       API 冒烟测试（不启 GUI）
```

## 发布

安装包**不进 git**（二进制会让仓库无谓膨胀），走 GitHub Release 分发。

### 自动（推荐）

`.github/workflows/release.yml` 会在推送 `v*` tag 时用 GitHub 的 Windows runner 编译并把 exe 挂到 Release：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

公开仓库的标准 runner 免费、不限分钟，产物存储也免费。

**版本号要先改 `package.json` 的 `version` 再打 tag**，两者需一致——安装包文件名和
`latest.yml` 都取自它，不一致会让客户端的自更新判断错乱。

Release 附件必须同时包含**安装包和 `latest.yml`**：后者是 `electron-updater` 用来
发现新版本的清单，漏了它客户端点了更新也找不到东西。CI 已经处理，手动发布时别忘。

### 手动

不想配 CI 的话，本地 `npm run dist`，然后到仓库页 Releases → Create a new release，
把 `dist/Mendeley-NG-<版本>-Setup.exe` 拖进去发布。

也可以在 Actions 页面手动触发上面那个 workflow（不推 tag 也行），
产物会作为 30 天有效期的 artifact 上传，不会创建 Release。

## 提交即推送（可选）

仓库里带了一个 `post-commit` 钩子，提交完自动推到远端，任务做完不用再记得 `git push`：

```bash
cp scripts/hooks/post-commit .git/hooks/post-commit && chmod +x .git/hooks/post-commit
```

`.git/hooks` 不进版本库，所以每次 clone 后要装一次。临时不想推就 `GIT_AUTO_PUSH=0 git commit ...`。

## 开发用的自检

```bash
npm run smoke              # 全流程：拉库 → 渲染窗口 → 点第一行 → 出两张截图
npm run smoke -- --no-sync # 用本地缓存，跳过同步
```

`--smoke` 会跑完整同步、开一个隐藏窗口、等渲染完成后用 `capturePage` 截图，
存到系统临时目录 `mendeley-ng-smoke.png` / `mendeley-ng-smoke-pdf.png`。
日志里会打出 `scaleFactor`、`devicePixelRatio`、canvas 的后备尺寸与 CSS 尺寸
（后者应该是前者的 `1/dpr`），这是验证高 DPI 是否真的生效的唯一可靠办法。

## 踩过的坑

- **`GET /documents` 默认 view 不返回 `citation_key` / `file_attached` / `folder_uuids`**，
  必须带 `?view=all`。
- **Cloudflare error 1010**：`api.mendeley.com` 会拦没有浏览器 UA 的请求，
  连 `/oauth/token` 也拦，所有请求都要带 Chrome UA。
- **`POST /folders` 必须用 `application/vnd.mendeley-folder.1+json`**，
  用默认的 document content-type 会 415。
- **`POST /folders/{id}/documents` 的 body 是 `{"id": did}`**，不是 `document_id`。
- **`DELETE /folders/{id}/documents/{did}`** 成功返回 204；目标本就不在该文件夹时返回 409，
  重复调用会 500。
- **本地库是 SQLCipher 加密的**，文件头不是 `SQLite format 3`，读不了，
  元数据只能走云端 API。1.19.8 自己存在库里的凭据同理取不出来。
- **主进程产物不能是 ESM**：package.json 里不要写 `"type": "module"`，
  否则 `require('electron')` 的 CJS 互操作会挂。
- **`app.quit()` 不接受参数**，要带退出码用 `app.exit(code)`。
