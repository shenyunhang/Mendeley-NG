# HANDOFF

给接手的人看的：这份文档只描述**当前**的代码与约定——跑得起来、知道哪里能动、
哪里是雷区。改动过程看 git 历史，面向用户的说明看 README。
文中不写本机路径、库规模或个人身份信息。

---

## 0. 一页速览

- **本地优先的 Mendeley 客户端**。Electron 33 + React 18 + pdf.js 4.10 直接读写
  Mendeley 云端库；云端只是同步源，不是宿主。
- 文献、PDF、正文索引、高亮、笔记全部落盘，读、搜、标注、导出都不经过网络。
  仍需联网的只有三件事：同步条目、下载 PDF、把高亮推回 `/annotations`。
- **改完代码按这个顺序跑**：`npm run typecheck` → `npm test` → `npm run build`
  → `npm run verify:build` → `npm run smoke`。顺序不能换：smoke 跑的是 `out/`
  里那一版，它不替你构建；产物校验要读刚构建的 `out/`。
- 三条分层约定：三端共享的规则只放 `shared/`；与 React 无关的纯规则只放
  `src/lib/`；IPC 契约只在 `src/global.d.ts` 定义一份。
- 运行时数据都在 `<userData>`（Windows 是 `%APPDATA%\mendeley-ng`）：
  `token.json`、`library/` 下的五个 JSON 与全文索引文件。它们都不在仓库里。

## 目录

| 节 | 内容 |
| --- | --- |
| 1 | 产品主张、三件事的层级、明确不做的事 |
| 2 | 跑起来、本地验证顺序、CI 与发布门禁、自检口径 |
| 3 | 代码结构与分层约定 |
| 4 | 工程约定：数据、凭据、仓库、图标、配置写入、测试纪律 |
| 5 | IPC 与信任边界 |
| 6 | Mendeley API 的怪癖 |
| 7 | 环境与打包 |
| 8 | 改这些地方之前先读（按主题） |
| 9 | 当前的取舍与边界 |

---

## 1. 产品主张与边界

### 1.1 主张

库在 Elsevier 的服务器上，而能完整打开它的桌面客户端正在被冻结：Mendeley
Desktop 停在 1.19.8，官方只保留关键安全维护，指定的接班人是另一个账号与云端优先的
产品。NG 不替代其中任何一个，它换的是**依赖关系**：同步下来的东西全部落本地，
读和搜都不取决于哪个客户端还活着。

诚实边界：同步、下载 PDF、推送高亮仍要联网。对外只说「不必依赖 Mendeley 的客户端，
暂时仍要依赖它的 API」，不写成「完全脱离 Mendeley」。API 关掉、token 过期或断网时，
屏幕上的库照常能用，不工作的只有同步与下载 PDF。

改这块时守住两条：任何新功能先问「离网能不能用」；任何把本地数据往云端搬的改动
（把笔记同步上去之类）都违反主张。每类数据都要有可见、格式通用、包含实际内容的出口，
「导出 → 带走整个库…」就是这条的兑现。

DPI 靠 Chromium 按系统 scale factor 缩放 CSS 像素，不加任何 DPI 补丁。字体发虚或
错位时先查是否引入了 `zoomFactor` / `--force-device-scale-factor`。DPI 只是
「为什么不用旧客户端」的理由，产品主张是「库在你自己手里」；别把项目读成为修字体大小而存在。

### 1.2 三件事与层级

按「离网能不能做」排，不按功能清单排：

| 层 | 是什么 | 判据 | 落在哪 |
| --- | --- | --- | --- |
| **读** | 把一篇 PDF 读明白 | 离网可用 | 渲染 / 翻页 / 缩放 / 篇内查找 / 目录 / 页内链接 / 高亮 / 笔记 / 标注侧栏 |
| **找** | 找到那一篇、那一处 | 离网可用 | 全文检索 / 字段搜索 / 筛选 / 排序 / 列定制 / 文件夹与标签 |
| **守** | 库在你自己手里 | 联网才能做，是**手段**不是目的 | 同步 / 本地 PDF 目录 / 下载 PDF / 导入 / 导出 / 引文格式 |
| 附带 | 库管理的传统动作 | 三层都不属于 | 查重合并 / 批量编辑 / 保存搜索 / 回收站 / 补全元数据 / 按标识符添加 |

三条规矩：

- 「守」层动作不占主位：联网按钮不做工具栏第一个、不做 `primary`。工具栏第一个按钮是
  「阅读」，它把 PDF 交给整个窗口（`.body.reading`）；再按一次同一个按钮直接回列表，
  Esc 和面板头的「← 回到列表」是另外两条出路。规则是 `src/lib/view.ts` 的
  `viewAfterReadingToggle`：只有 `reader` 回列表，其它视图一律进阅读。阅读模式下按钮
  不受 `canRead` 限制，免得论文失去本地 PDF 时连列表都回不去。右栏 PDF 页签这条通路
  保留，新增路径不替换它。
- 「读」层动作不挤在右栏 `PdfViewer` 内部；附带层收在「更多」里，新功能默认也进那里。
- 工具栏恒为一行、不溢出。溢出会让按键那一帧抖到几百毫秒，判据是
  `the bar fits without being scrolled`，不要改断言去迁就布局。

### 1.3 明确不做与可接受的差距

写下来是为了避免后来人热心补回来：

- **Word / LibreOffice 引用插件**：要引 CSL + citeproc + 各办公软件插件体系，是另一个
  量级的工程，官方已有 Mendeley Cite。折中是「复制格式化引文」。
- **分组协作**：`/groups` 已标 deprecated，1.19.8 末版已移除建组入口。
- **相关文献推荐 / 站内文献检索 / 个人主页 / 关注者**：依赖已下线的社交图谱。
- **下划线 / 墨水 / 文本标注**：云端 `/annotations` 只认 `highlight` 与 `sticky_note`，
  硬做会变成「本地能画、云端丢一半」。
- **多附件 / 快照 / EPUB / 附件缩略图**：Mendeley 一条就一个主文件；按标识符添加 +
  拖 PDF 已覆盖抓取场景。
- **浏览器扩展抓取、AI 摘要 / 问答**：前者已被覆盖，后者会把「不联网也能用」这个
  最大优点搭进去。
- **双栏重排（reflow）与引文网络推荐**：前者要重排整篇 PDF，后者要联网要语义。
- **全文检索只索引每篇前 N 页**（默认 3）：这是能力取舍不是缺陷，但必须让人看得见——
  搜不到时的空态要写明读了多少、这证明了什么、去哪改页数并重建，别让人误判成库里没有。
  改页数会丢索引，因为它描述的已经是另一份语料。

---

## 2. 跑起来与验证

### 命令

```bash
npm install
npm run build              # 产出 out/；不替 smoke 构建
npm run verify:build       # 校验 out/ 产物；CI 与 release 共用这一份脚本
npm start                  # 启动，走 scripts/start.mjs
npm run dev                # 热重载
npm run typecheck          # main/preload 与 renderer 双侧检查
npm test                   # Vitest，纯 Node 单测
npm run test:watch
npm run dist               # 打包 Windows NSIS 安装包
npm run smoke              # 真实库 + 真实 PDF 的端到端自检
npm run smoke -- --no-sync # 用本地缓存，跳过同步
npm run perf               # 真实库上的按键 / 滚动测量
npm run demo               # 造虚构库，重生成 README 的四张截图
```

**首次使用需要 token**：项目没有内置 client credential，每人都要注册自己的应用。
完整步骤见 README「获取 token」，或跑
`node scripts/get-token.mjs <client_id> <client_secret>`。

### 本地验证顺序

按 `typecheck` → `npm test` → `build` → `verify:build` → `smoke` 的顺序跑，一步都不能省：

1. `npm run typecheck` 是唯一真正做类型检查的入口。根 `tsconfig.json` 是
   `files: []` + `references`，`npx tsc --noEmit` 等于跑空。两个工程分别覆盖主进程与
   渲染层，`tsconfig.node.json` 的 `include` 是手工白名单，新增一个被主进程或单测
   import 的 `src/lib` 纯函数就要列进去，否则报 TS6307。
2. `npm test` 跑 `tests/` 下的 Vitest 用例：不开窗口、不碰真实库、不启动 Electron，
   是 shared 规则、渲染层纯函数、安全边界与主进程 IPC 唯一的自动化回归。
   `main-ipc-*.test.ts` 用 `vi.mock('electron')` 把 Electron、云端客户端、JSON 缓存
   和索引驱动换成桩，捕获 `ipcMain.handle` 注册的 handler 后直接调用——测的是
   channel 回答什么（含失败形态），不是源码里有没有那一行。
3. `npm run build` 产出 `out/`。`scripts/start.mjs` 只检查 `out/main/index.js` 在不在，
   然后直接起 Electron，所以忘了构建跑的是上一版，而且会**安静地全绿**。
4. `npm run verify:build` 逐个 `node --check` 主进程与 smoke chunk、确认 worker 在且
   大于 100 KB、确认 `out/renderer/` 下的 cMap 与标准字体资源齐全、确认 `index.js`
   引用的 chunk 真实存在，并核对 `build` / `dist` / `prebuild` / `asarUnpack` 的接线。
   同一份 `scripts/verify-build.mjs` 被 `ci.yml` 与 `release.yml` 调用，两处门禁不会漂移。
5. `npm run smoke` 用真实库和真实 PDF，开隐藏窗口逐条断言，日志以
   `[smoke] PASS` / `[smoke] FAIL` 打点，最后出现 `all checks passed` 才算过。
   断言数会变；只数 `smoke.ts` 的 `expect(` 会漏掉 `smoke-*.ts` 里的 `ctx.expect(`，
   且有分支断言只在数据满足条件时才跑。不要把具体数字写进文档。

### CI 与发布门禁

- **`actions/checkout` 在 release.yml 必须 `fetch-depth: 0` + `fetch-tags: true`**。
  版本门禁用 `git cat-file -t <tag>` 判 annotated，而默认的浅检出可能只取到
  commit、本地根本没有 tag ref，于是正确的 annotated tag 也会被判失败、整个
  release 被 skip（`v0.1.112` 首次 run 42789647855 就是这样）。门禁里还显式
  `git fetch origin refs/tags/<tag>:refs/tags/<tag>` 作第二道保险，失败时打印
  `show-ref --tags`，别让日志只剩一个 exit 1。
- `.github/workflows/ci.yml` 在每次 push / PR 依次跑 `typecheck`、`npm test`、`build`，
  再调 `node scripts/verify-build.mjs` 验一遍 `out/`：逐个 `node --check` 主进程与全部
  smoke chunk、确认 `out/preload/index.js` 与 `out/renderer/index.html` 在、确认
  `pdf.worker.mjs` 大于 100 KB、确认 `index.js` 里 require 的 chunk 文件真实存在、
  `out/renderer/cmaps/` 与 `standard_fonts/` 都齐，并核对 `build` 仍含 `copy-worker`、
  `prebuild` / `predev` 仍调 `copy-pdf-assets`、`dist` 仍委托 `npm run build`、
  `asarUnpack` 仍覆盖两个资源目录。
- `.github/workflows/release.yml` 在 `v*` tag（或手动触发）打包前先跑
  `npm run typecheck && npm test`，再做同一道产物检查，并拒绝版本与
  `package.json` / `package-lock.json` 不一致或不是 annotated 的 tag；手动触发
  没有 tag，这一步整个跳过。tag 可以指向任意提交，不能假定它走过 CI。
- **`smoke` 不进 CI**：它要真实库、真实 PDF 和一个真正显示的窗口，还要量按键那一帧
  的主线程耗时，托管 runner 给不出诚实的答案。

### 自检口径

`--smoke` 拍 `mendeley-ng-smoke.png` 与 `mendeley-ng-smoke-light.png` 到系统临时目录，
浅色是临时改 DOM 拍完还原，不动用户配置。两张都在点开第一行 PDF **之前**；点开之后
改为读 canvas 后备尺寸与 CSS 尺寸（前者应是后者的 `dpr` 倍）——这是验证高 DPI 是否
生效的唯一可靠办法，比肉眼看截图靠谱。

自检会造一次合成选区验证文本层能选出文字并算出正确矩形，然后把配置与
`annotations.json` 按文件快照恢复回去。开跑前检查有没有第二份 Mendeley NG 在跑
（两份会写同一个 `config.json`，跑出来的红是随机的），有就拒绝；确需降级用
`SMOKE_ALLOW_OTHER_INSTANCE=1`。

`--demo` 与自检方向相反：自检要真实数据才测得准，截图要假数据才敢公开。它用
`--user-data-dir=.demo` 把缓存、配置、索引全关在 `.demo/` 里，`library:sync` 直接
返回本地缓存、不联网；论文与 PDF 当场生成，索引也就地建。
`--perf` 用真实库、跳过同步、只测不判，同时记 `longtask` 与 rAF 帧间隔。

---

## 3. 代码结构与分层

```
electron/main/
  index.ts              入口：单实例、自定义协议、这次是哪一种启动
  window.ts             窗口创建、隐藏的系统标题栏与 bounds 记忆、往渲染器推状态
  menu.ts               隐藏的中文角色菜单，保住复制/粘贴/开发者工具的快捷键
  instance.ts           单实例锁与第二次点击
  library.ts            同步（增量水印、PDF 挂载、缓存合并）
  mendeley.ts           Mendeley REST 客户端
  auth.ts / lookup.ts   OAuth 窗口、Crossref / arXiv 查元数据
  store.ts / pdfindex.ts / pdfname.ts  本地缓存、文件名匹配、命名模板
  fulltext.ts / ftops.ts 正文索引与驱动层
  refsindex.ts           参考文献索引
  updater.ts / demo.ts / perf.ts  自更新与两种开发期运行模式
  smoke.ts              冒烟入口：窗口、快照、共享 expect、收尾与配置恢复都留在这里
  smoke-*.ts            六个纯 Node 断言块 + smoke-ctx.ts 的共享类型，静态 import
  ipc/                  library / system / docs / marks / refs / files，按域注册
electron/preload/index.ts  contextBridge，按 Api 契约暴露白名单方法
src/
  App.tsx               组装层：把 hooks 解构出来排进 JSX
  global.d.ts           唯一的 IPC 契约 Api
  window.d.ts           Window.api 的 ambient 声明（与 DOM 隔离）
  components/           视图组件，PdfViewer.tsx 是阅读器、TitleBar.tsx 是工具栏内的窗口身份片段
  lib/hooks/            React 状态簇，按「谁跟谁一起变」切
  lib/hooks/useOverlayStack.ts  设置面板与三张工具条卡片的状态 + 一次 Esc 关一层
  lib/searchScope.ts    唯一的检索归一化、范围枚举与篇内查找词长
  lib/mergeFields.ts    查重合并只补空缺字段的纯规则
  lib/budgets.ts        下载并发、路径 flush 与批量进度的具名预算
  lib/                  与 React 无关的纯规则，可直接在 Node 里 import
  lib/overlayStack.ts   浮层优先级的纯规则 topOverlay
  lib/searchScope.ts    搜索范围枚举、标签与 scopeHay 纯规则
  lib/configWrite.ts    渲染层所有配置写入的统一入口
  lib/batch.ts          批量动作的进度节流与失败名单，不碰 React
  styles.css            样式唯一入口，只有一串按原顺序排列的 @import
  styles/               从原单文件逐字切出的十四个分片，规则顺序不可重排
shared/                  三端共享：类型、规则常量、原子写、安全策略、索引规则
                         indexedFileRules.ts：两套索引共用的文件判定、片段与进度
                         fulltextRules.ts：全文表的形状、偏移、页码与 worker 故障
                         librarySync.ts：把云端回答变成同步提议的三条纯规则
                         pdfFontOptions.ts：pdf.js 字体资源的目录名与两种取法
                         titleBarTheme.ts：单行 chrome 的高度与两套主题色（CSS 变量的镜像）
tests/                   Vitest 单测：shared / renderer-pure / security / refactor-regression
                         main-ipc-system / main-ipc-files（Electron 用替身，捕获 handler）
                         main-library / main-marks（同步 pull、标注与阅读位置的接线）
                         library-sync / overlay-stack（抽出的纯规则）
                         pure-modules（export / importText / updateText / doctypes 的纯 Node 用例）
                         refactor-2026-11-16（页数与归一化的逐值差分 + 源码串护栏）
scripts/
  _shared.mjs           脚本共用：仓库根、Electron 路径、环境清理、UA
  verify-build.mjs      产物校验，ci.yml 与 release.yml 只调这一份
  copy-pdf-assets.mjs   prebuild / predev 填 Vite publicDir 的 cMap 与标准字体
  ...                   启动器、token、假库与截图、图标、worker 拷贝、签名自查、钩子
docs/screenshots/        README 的四张图，由 npm run demo 生成
analysis/                三份分析报告（架构实现 / 演化 / 第一性原理与巧思，各含 md + 自包含 html）
.github/workflows/       ci.yml（类型 / 单测 / 构建 / 产物）、release.yml（打包与发布）
vitest.config.ts         test 只收 tests/**/*.test.ts，环境为 node
electron.vite.config.ts  main / preload / renderer 三段构建配置
```

分层约定：

- **哪一层能改状态**：`App.tsx` 与 `src/lib/hooks/` 持有状态；`src/lib/` 与 `shared/`
  是纯规则，不碰 React / DOM，所以主进程、冒烟和单测都能直接喂假时钟与手控 promise
  去验证。判断一个 hook 该不该拆，看「这段回答哪个问题」，不是「这段长不长」。
- `useConfig` 必须在 `useLibrary` 之前调用，后者用前者的 `syncOnStart` 决定是否启动同步。
  `PdfViewer` 只留缩放、翻页、拖选与 JSX；几何 / 位图 / 文本 / 查找 / 选区放
  `src/lib/pdf*.ts`，连续滚动账本放独立 hook。
- 类型只在 `shared/types.ts` 改，不在三处各写一份；跨 IPC 的规则（页数预算、位图尺寸、
  夹取、延时、静默失败、路径策略）也只留一份，别在调用点手抄。检索归一化只有
  `src/lib/searchScope.ts` 一份；两套索引的基础设施共用 `shared/indexedFileRules.ts`，
  全文表的只读规则在 `shared/fulltextRules.ts`；纯规则下沉时同步在 `tests/` 留一份
  旧表达式逐值差分，探测器先喂旧写法证明抓得到。
- `src/global.d.ts` 定义唯一的 `Api`，preload 用 `const api: Api = {...}` 在编译期照它
  校验；`src/window.d.ts` 只提供 `Window.api` 的 ambient 声明，这样主进程工程 import
  契约时不会被拉进 DOM 的 `Window` 类型。
- 所有尺寸用 rem（`--ui-fs` 为基准），不写死 px，否则字号旋钮失效。
- 主进程产物必须是 CJS，`package.json` 里不能加 `"type": "module"`；
  `contextIsolation: true`，renderer 拿不到 node，所有能力走 `window.api`。
- 新增 IPC 通道按「属于哪个域」放进 `electron/main/ipc/` 对应文件，不往入口列表里插。
- `--smoke` 走动态 `import('./smoke')`，作为独立 chunk 与 `index.js` 平级产出。
  `electron.vite.config.ts` 的 `chunkFileNames` 必须保持这个布局：主进程用 `__dirname`
  定位 preload、renderer html 和项目根，chunk 多一层目录会让这些路径全部失效。

---

## 4. 工程约定

### 数据与凭据

- token 在 `<userData>/token.json`、`<userData>/mendeley-token.json` 或环境变量
  `MENDELEY_TOKEN_PATH` 指向的路径；应用会依次找。
- `library/` 下：`library.json`（文献与文件夹）、`annotations.json`（标注）、
  `config.json`（偏好）、`notes.json`（文献级笔记，只在本机、界面写明不同步）、
  `reading.json`（阅读位置）、以及全文索引文件。换机器要重新导入 token。
- 提交前确认没有 `token.json` / `.env` / 硬编码个人路径入库，`.gitignore` 已拦截。
- 原子写盘统一走 `shared/atomicJson.ts` 的 tmp + rename。`token.json` 等凭据与
  `saveConfig` 的内联写法是**刻意例外**：前者涉及 inode / 明文 tmp / 文件权限，后者
  受一条源码串断言守护。动这两处先改约定和断言。
- 配置写盘在渲染层统一走 `src/lib/configWrite.ts` 的 `writeConfig`。它把失败交给
  App 注册的错误提示，不让「内存已更新、磁盘没写进去」无声发生。
- `reading:set` 每次先 `loadReading()` 再合并再 `saveReading()`，不留进程内快照。
  曾经缓存一份在 handler 闭包里，外部（第二个窗口、恢复、手改）一写就过期，
  下一次 set 会把旧页码写回去，而 `reading:load` 读的是文件、两边答案不一致。
  文件只有每篇一个页码，多读一次的成本可以忽略。

### 仓库

- 远端 `github.com/shenyunhang/Mendeley-NG`，分支 `main`。
- `scripts/hooks/post-commit` 是自动推送钩子的规范副本，新 clone 后复制到 `.git/hooks/`
  并 `chmod +x`；`.git/hooks` 不进版本库。临时不推用 `GIT_AUTO_PUSH=0 git commit`。
- 安装包不进 git，走 GitHub Release 分发；版本 bump 单独一个 commit，
  `package.json` 与 `package-lock.json` 的 `version` 必须与 tag 一致。
  tag 必须是 annotated（`-a`），轻量 tag 不会触发 release workflow。
- `scripts/_shared.mjs` 是所有脚本的公共底座：仓库根（从 `import.meta.url` 算，不看 cwd）、
  Electron 二进制、`cleanEnv()`（剔除 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`）、`UA`。
  新增脚本不要再抄这四样。`UA` 在 `shared/userAgent.ts` 里还有一份 TS 字面量（CJS 主进程
  不能直接 import `.mjs`），`tests/refactor-2026-11-16.test.ts` 逐字比对两份，改一边忘
  另一边会红。`scripts/verify-build.mjs` 是产物校验的唯一实现，两个 workflow 只调它。

### 图标与截图

- 图标只改 `scripts/make-icon.mjs` 的形状表；`assets/logo.svg`、`build/icon.ico`、
  `build/icon.png`、`assets/icon.png` 全是脚本产物并故意提交（CI 没有 SVG 光栅化器）。
  手改产物会在下次 `npm run icon` 被覆盖，位图与矢量必须同一份描述。
- 光栅化用脚本自带的 4 倍超采样 + 面积平均，不用 Electron 渲染 SVG。
  在 16 px 检验形状，不设彩色底板；`assets/logo.svg` 保持在 4 KiB 以内，否则
  `.about-logo` 会从内联 data URL 变成外链。
- README 截图只许用 `npm run demo` 生成的四张虚构库图，不许对真实库拍照。
- 隐藏窗口不主动重绘，`capturePage()` 可能交回上一帧：`demo.ts` 的 `shot()`
  先等两帧再截图，否则详情面板明明有值、图片里却是一排空输入框。浅色那张还要
  临时关掉 CSS 过渡——隐藏窗口不会把过渡推进到终点，按钮会留在深色配色，
  拍出半深半浅的图。这两处只影响截图脚本，产品里的过渡照常保留。
- 加了过渡的组件改主题色时留意 `--bg-2` / `--fg`：它们是
  `shared/titleBarTheme.ts` 里系统标题栏按钮颜色的镜像，不能只改 CSS。

### 测试纪律

- 纯规则配固定输入的行为断言；源码串断言只用来佐证接线，重构时应随产品代码一起
  校正并写明旧串为什么不再成立，**不放宽判据**。
- 主进程 handler 的桩打在输入侧：替身 `electron` 及被 import 的云端客户端、缓存、
  索引驱动，捕获 `ipcMain.handle` 后直接调用 channel。别给产品模块本身打桩，
  也别让 `app.getPath('userData')` 落到真实用户目录。临时目录要在异步用例
  `await` 完之后再删，否则断言读的是已经被清理掉的文件。
- 以「没有找到任何 X」为结论的断言，先证明探测器找得到 X（喂一段旧代码进去必须抓到）。
  数调用点数 `name(` 而不是 `\bname\b`，并排除声明与 import 路径。
- 抽共享规则前把旧表达式逐行抄进测试、对大批量输入逐值比，并单独证明退化差异真实存在。
  共享常量不等于共享规则，「怎么夹取」也要收进同一模块。
- 回退验证的判据是红点逐条一致、基线连跑多轮；先怀疑机器、再怀疑代码、最后怀疑
  自己的改动，方法是撤掉改动再跑一遍，而不是盯数字猜。
- 桩打在被测代码的输入侧，不打在被测代码身上；对照的两端必须来自同一个对象。
- 冒烟里「按年份翻方向」的断言读的是**可见**结果卡的 `.res-year`。`sortValue`
  曾把没年份的文献当成 0，升序时它们排在最前；`--res-h` 从 5.2 提到 6.4rem 后
  一屏卡片变少，整屏都是无年份文献，`yearsShown()` 直接返回空数组，
  连红两条断言。产品侧现已让无年份文献两个方向都排最后（见 §8.3）；冒烟仍保留
  「滚到第一批有年份的卡片再读」作为兜底，判据（真实年份严格升序、首尾年份
  对调）一个都没放宽。别改成「配置里 dir 翻了就算过」。
- 写下的诊断动手前要复核一次；文档不写死会变的数字。
- 冒烟窗口隐藏且 rAF 节流，等待被测对象用 `until` + 上限而不是固定 sleep；
  前提要单独写一条会说话的断言，前提不成立时别静默跳过后续断言。
- 跑冒烟时别在旁边跑 `npm run build` / `npm run perf`，它们会改 `out/` 或抢真实库。
- 安装版开着又必须跑冒烟时，**别直接 `SMOKE_ALLOW_OTHER_INSTANCE=1`**：两份会写同一个
  `config.json`，红是随机的。改用隔离数据目录——把
  `<userData>/library`（约 80MB，含 library.json / fulltext.dat）拷到临时
  `--user-data-dir` 下，再用 `MENDELEY_TOKEN_PATH=<真实目录>/token.json` 指向**原文件**
  （不复制凭据），最后 `SMOKE_ALLOW_OTHER_INSTANCE=1 npm run smoke -- --no-sync
  --user-data-dir=<临时目录>`。这样守卫仍会提示「另一份在跑」，但两边写的不是同一个
  config，降级是安全的；`findToken()` 也会返回 true，启动同步那两条断言不会误红。
  跑完删临时目录。
- **源码串护栏不能假设 LF**。`windows-latest` 的 checkout 是 CRLF，
  `toContain('.title-bar {\n  display: none;')` 本地通过、CI 从 `997c514`
  起连红五个提交，release 也跟着卡在单测；读文件先把 `\r\n` 归一成 `\n`，
  `tests/title-bar-theme.test.ts` 另有一条护栏禁止 `toContain` 的参数里再出现
  `\n`。改这类断言后，用一份 CRLF 副本（`git ls-files` 拷出文本并换行转换、
  软链 `node_modules`）跑一遍完整 `typecheck`/`test`/`build`/`verify:build`，
  别只信本地 LF 的绿。

---

## 5. IPC 与信任边界

渲染进程是 `file://` 页面、`contextIsolation: true`，但它发过来的**数据仍然不可信**。
所有路径与输入校验集中在 `shared/pathPolicy.ts`，平台参数可注入以便确定性测试：

- `mendeley://pdf/<path>` 只服务 `pdfDir` 根内的文件，或 `library.json` 里已登记的
  `localPdf` 附件（`canServePdf`）。别把这个协议当成第二个文件 API。**不要新增任何
  「传一个路径进来、直接 `fs.readFileSync` 返回字节」的 IPC 通道**：那种通道绕过
  `pathPolicy` 且渲染层无法证明路径是自己的 PDF。
  `tests/refactor-2026-11-16.test.ts` 有源码串护栏防止这类通道回来。
- `export:leave` 的每个 `files[].name` 与 `copies[].to` 先经 `resolveInside` 解析到所选
  目录内，任何一个越界就整批拒绝；`../`、绝对路径、盘符相对名、UNC 与 NUL 都拒收。
  复制源 `from` 不限制，导出的是用户自己的 PDF。
- `dialog:saveText` 的 `name` 只取 basename，`ext` 只接受字母数字后缀。
- `shell:openExternal` 只放行 `http:` / `https:`（`isSafeExternalUrl`）。
- `config:set` 只接受 `safeConfigPatch` 白名单内的键与类型；未知键、非有限数值、
  非法 `theme`、`__proto__` 类键一律丢弃。白名单用
  `satisfies Record<keyof AppConfig, true>` 声明，新增配置字段却忘了决定是否可写，
  是编译错误而不是静默忽略。写入 `ftPages` 时同步调 `setFullTextPages` 让索引立刻生效。

契约与错误处理：

- `Api` 只在 `src/global.d.ts` 定义一份，preload 编译期照它校验；新增或改签名时
  两边不会再各自漂移。所有 `ipcRenderer.invoke` 都带返回类型断言，不留 `Promise<any>`。
- handler 的失败形态不统一：一部分返回 `{ error }`，一部分（例如 `doc:*` 在无 token 时）
  直接 reject。渲染层两种都要处理。
- 配置读取、全文索引控制、四个导出动作与本地缓存读取都有 rejection 边界；
  「静默失败」走 `shared/failures.ts` 的具名 `ignoreFailure` / `reportFailure` 两道门，
  不写没有名字的空 catch。

---

## 6. Mendeley API 的怪癖

改这块之前必读：

- `GET /documents` 必须带 `?view=all`，否则不返回 `citation_key` / `file_attached` /
  `folder_uuids`。
- `api.mendeley.com` 有 Cloudflare 1010 拦截，所有请求（含 `/oauth/token`）都要带
  Chrome UA，规则在 `shared/userAgent.ts`。
- `POST /folders` 必须用 `application/vnd.mendeley-folder.1+json`，默认 content-type
  直接 415；`POST /folders/{id}/documents` 的 body 是 `{"id": did}`，不是 `document_id`。
- `DELETE /folders/{id}/documents/{did}` 成功返回 204，目标已不在该文件夹返回 409，
  重复调用会 500。
- 本地库是 SQLCipher 加密的，1.19.8 存在里面的凭据也取不出来，元数据只能走云端 API。
- `file_attached` 不可信，同步时额外拉一次 `/files` 交叉核对；`/files` 的分页 `marker`
  是文件自己的 `id`，不是 `document_id`，并加「整页都是见过的 id 就停」防死循环。
- `GET /files/{id}` 返回 303 到 S3 预签名地址，跳转时不要再带 Authorization 头；
  预签名下载并发高了是被拒不是排队，并发限 2–3、失败跳过、给进度和可停止。
- `POST /documents` 带 PDF 裸字节加两个头（`Content-Type: application/pdf`、
  `Content-Disposition: attachment; filename="..."`），一次建条目并自动附件。
  multipart 会被拒且报错有误导性；服务端会自己从 PDF 抽元数据，别用文件名回填标题。
  `doi` / `arxiv` 写在顶层无效，真字段是 `identifiers`。
- 云端把导入时收集的来源地址放在 `websites` 数组里，`url` 是另一个可编辑字段；
  本地缓存里几乎每篇的 `url` 都是空的。详情面板的「链接」输入框读写 `url`，
  它下面那组只读来源链接由 `src/lib/documentSourceLinks.ts` 从 `url`、每个
  `websites[i]`、`identifiers.doi` / `doi`、`identifiers.arxiv` / `arxiv`
  逐条推导，标签就是字段名，重复地址也各占一条，不写回云端。
- `POST /documents` 只接受固定 `type` 集合，用 `DOC_TYPES` 白名单做下拉；库里有但
  白名单没有的值留空并显示「（未设）」，别顶成第一项。
- 标注坐标是绝对 PDF 点，`top_left` 存 y 更小的那个点即视觉左下角，
  视觉顶部 = `pageHeight - max(y)`。`POST /annotations` 必须带 `filehash`
  （云端文件字节的 SHA-1），缺了会静默降级成 note 并丢 `positions`；
  `filehash + positions + text` 是 `sticky_note`，无 `text` 才是 `highlight`，
  所以高亮绝不能带 `text`。
- `POST /notes` 与 `GET /notes` 都是 404，文献级笔记只能落本地且界面写明不同步；
  `tags` 清空后 PATCH 回来的响应里没有 `tags` 字段（不是空数组）。
- `GET /metadata` 官方标着未实现，补全元数据走 Crossref / arXiv / `/catalog` 兜底。
  `GET /catalog?doi=` 可用，`?arxiv=` / `?isbn=` / `?pmid=` 会返回无关记录，
  arXiv id 一律走 `export.arxiv.org`。`/catalog` 拒绝匿名请求，按 DOI 添加时先传
  bearer，没 token 就降级到 Crossref。`/catalog` 会把标题改成句首大写，所以 DOI 解析
  用 Crossref 与 catalog 并行取再合并，重叠字段以 Crossref 为准。
- `GET /documents?modified_since=` 与 `?sort=created&order=desc` 可用；
  `/deleted_documents` 是 404，`GET /trash` 是删除通道，每次同步（含增量）都取它的
  id 集合对账；彻底删除要 `DELETE /trash/{id}`。
- OAuth 没有 PKCE，code flow 必须带 `client_secret`；implicit flow 不返回 refresh token。
  需要输入一律用应用内 `AskDialog`，不用 `window.prompt()`（Electron 里会抛，
  但 `typeof` 是 `function`，静态检查看不出来）。

---

## 7. 环境与打包

- 某些 shell 会导出 `ELECTRON_RUN_AS_NODE`，带着它启动 electron.exe 会退化成纯 Node，
  主进程死在 `app.whenReady()`。`scripts/start.mjs` 剔除该变量后再 spawn，
  不要改回直接 `electron .`。
- `app.quit()` 不接受参数，带退出码用 `app.exit(code)`。
- electron-builder 的 rcedit 在本机写 exe 版本资源会报错，用
  `build.win.signAndEditExecutable: false` 绕过；代价是 exe 在资源管理器里仍是
  Electron 默认图标，窗口 / 任务栏 / 安装包 / 快捷方式用我们的图标。
- 打包 `files` 是 `out/**/*`、`package.json`、`assets/icon.png`；`build/` 是
  buildResources 目录，不会打进 app，窗口图标用 `assets/icon.png` 那份副本。
- `dist` 委托给 `build`，不再抄一遍构建链：`build` 是
  `electron-vite build && node scripts/copy-worker.mjs`，`dist` 是
  `npm run build && electron-builder --win --x64`。从前两条命令各写一份
  copy-worker，改一处忘另一处就会装出没有 worker 的包，每篇 PDF 都抛
  `No "GlobalWorkerOptions.workerSrc" specified`。**往 `build` 里加东西时
  不必再问 `dist`，但要确认 `dist` 仍然只走 `npm run build`。**
- 主进程用 pdf.js 必须自带 worker。冒烟读 PDF 测不出打包缺件：要查
  `out/main/pdf.worker.mjs` 存在且大于 100 KB、`build` 脚本仍含
  `copy-worker`、`dist` 脚本仍委托 `npm run build` 并调 electron-builder；
  CI 与 release 另有一道产物门禁，逐个 `node --check` 主进程与 smoke chunk、
  核对 `index.js` 里 require 的 chunk 文件真实存在。复现打包缺件去看装好的包
  （`npx asar list …/resources/app.asar`），不是看源码目录。
- pdf.js 的字体资源是运行时按 URL 拼文件名取的，不是 JS 模块，Vite 发现不了
  漏拷：`prebuild` / `predev` 调 `scripts/copy-pdf-assets.mjs` 把
  `pdfjs-dist/cmaps`（169 个 `.bcmap`）与 `standard_fonts`（16 个 `.pfb`）放进
  Vite publicDir，构建后落在 `out/renderer/`。所有 `getDocument` 统一从
  `shared/pdfFontOptions.ts` 取 `cMapUrl` / `cMapPacked` / `standardFontDataUrl`：
  渲染层按 `document.baseURI` 拼 URL，主进程按 `out/renderer` 拼路径（Node 工厂
  用 `fs.readFile`，不吃 `file://`）。**安装包必须 `asarUnpack` 这两个目录**——
  Chromium fetch 不到 `app.asar` 里的文件，Electron 会把请求重定向到
  `app.asar.unpacked`。缺资源时 CID 字体加载失败，pdf.js 换 ErrorFont，canvas
  静默丢字形：插图的框线箭头都在、框内文字全空，篇级诊断还不会报错。
- 诊断不能替文件背锅：库级故障（一轮一篇都没读出来）与篇级失败分开报，
  面板把 pdf.js 的原话原样显示。
- `electron-builder` 没有证书时静默跳过签名，安装包照常能跑；用 `npm run signcheck`
  （`Get-AuthenticodeSignature`）问 Windows 拿真实状态，别只看构建成功。
  `release.yml` 里「有证书却没签上」判失败，「没有证书」只警告。
- Release 附件必须同时包含安装包和 `latest.yml`，后者是 `electron-updater` 发现新版本
  的清单，漏了客户端点了更新也找不到东西。
- 从 PDF 抽文本只能用 pdf.js；纯 zlib + 正则取 `Tj`/`TJ` 在真实论文上召回率近零
  （subset 字体存的是字形索引）。

---

## 8. 改这些地方之前先读

### 8.1 全文索引

- 索引错了比没有索引更糟：建完直接审索引文件本身——一条 entry 一篇不重复、无空文本、
  `entry.file` 还在且大小对、每个命中能在所属那篇的文本里找到、页码落在该篇页数内。
- 搜索 hay 用 `Map<id,string>` 缓存，只在 docs / notes 变化时重算；追加与全量建索引
  不能同时写 `.dat`，用一个 `busy` 互斥排队。追加完把内存 blob 置 null；
  entry 表为空时不许追加；自动建索引不阻塞 UI。
- 全文是追加 + 改指向，不是原地覆盖（offset 是 UTF-16 code unit、文件是 UTF-8 字节，
  除文件末尾无法定点回写），换文件留的孤儿文本只由 rebuild 回收。
- `truncate` 与 entry 表同一次 `saveMeta`，`bytes` 每次 `writeSync` 后就地更新、
  是唯一可靠的锚点；不要用「读一遍文件数 code unit」对齐。只处理行末连字符，
  `skipped` 只在结束时报一次。
- 索引作废分 `format` 与 `budget` 两种原因各说各话；空态用
  `done > 0 && skipped.length` 区分「从没建过」与「跑完但零篇」，且放在
  `!status?.indexed` 分支之前；`skipped` 字段必填。
- 搜索只在词变化时跑，但「索引建完」也算一次变化：用 `ftEpoch` 在 `building`
  由 true 变 false 时 +1 并放进依赖，`ftWasBuilding` 在 `onFtProgress` 与
  `ftBuild().then()` 两处都更新。
- 页数的边界与默认值只有一份规则（`shared/fullTextPages.ts`）：设置面板、索引构建
  和开机时的配置恢复共用，不会出现界面说 3 页、索引却按 50 页建的情况。
- 两个索引不各写一份基础设施：`sameIndexedFile`（mtime+size，追加路径额外比 `file`）、
  `snippetAround`（先按原文本切片再折叠空白）、`progressAllowed` 都在
  `shared/indexedFileRules.ts`；`fulltext.dat` 表的形状、偏移定位、页码与 worker
  故障判定在 `shared/fulltextRules.ts`。两处的旧表达式逐字抄在
  `tests/indexed-file-rules.test.ts` 与 `tests/fulltext-rules.test.ts` 里做逐值差分。

### 8.2 阅读器与 PDF

- 清缓存不等于作废在途渲染：缓存带代次，stale 时让这次 warm 失败（`StaleFlight`），
  别给每个调用点补判断。
- 用裸 `pdfjs-dist` 的 `getTextContent()` 自建每页命中表，不引 `pdfjs-dist/web` 的
  viewer / `PDFFindController`；缓存按文档 + 页存。
- pdf.js 不允许同一 canvas 并发渲染，缩放触发第二次 render 前必须 `cancel()`
  上一个 RenderTask 并吞掉 `RenderingCancelledException`。
- 预取的离屏渲染排在可见页之后，加入正在飞的 `Map<key, Promise<canvas>>` 而不是重开
  一次；缓存按 `页:缩放:dpr` 做 key + LRU，不在缩放变化时整表清空。
- 缩放后只重绘视口附近的页，用 `src/lib/continuousScroll.ts` 的
  `pagesNearViewport` 按 `REPAINT_MARGIN_PX` 决定范围，和 IntersectionObserver 的
  `rootMargin` 共用同一个数。旧实现把整列 `[data-page]` 全塞进 `visible`，
  于是一次 Ctrl+wheel 的每一步都把整篇重画一遍；全窗口阅读模式窗口大、视口内页多、
  位图也大，所以比右栏卡得多。别把「已经在屏幕上的页」写成遍历所有页。
- 连续滚动里「适宽」取最宽的那一页算、整列共用一个稳定缩放，不按当前页算，
  否则滚动→重排→改滚动位置死循环；改窗口大小不重新适宽。
- 阅读器键只在右侧是 PDF 页签且焦点不在输入框时生效，capture 阶段
  `stopPropagation` 抢键，别让 App 的全局 handler 把 ↑↓/Space/Home/End 拿去滚列表；
  切文档写回页码挂在「文档已稳定」之后。
- Ctrl+滚轮缩放用
  `window.addEventListener("wheel", h, { passive: false, capture: true })`，
  不能用 React `onWheel`（passive 忽略 `preventDefault`），也不能挂 pane 元素
  （文档没加载时不在 DOM）。
- 查找条 `position: absolute` 挂在 `.pdf-body`（给 `relative`），不挂 `.pdf-scroll`。
  命中标记标检索词而不是命中片段；扫描能在查找条关着时跑，`findOpen` 只进条件
  不进依赖；词驱动时只 `setFindAt` 当前页首个命中、绝不 `setPage`。
- 画布「画过了」要读 `getImageData` 数 alpha 非零点（`canvas.width` 默认 300，
  让「有画布且 width > 0」永远为真）；按页 + 缩放记账的缓存键必须带文档 id。
- 引用弹窗只认 DOI / arXiv id，核不上的一律不画热区；参考文献不一定在末页，
  从最靠后的 `References` 标题往前试；热区画在链接层之上。
- 高亮做成默认关的开关，开启时指针变十字、不记忆它；划下来的那句话一并存下
  （只有矩形的高亮换个地方就没法读）；笔记框始终属于当前选中的那一条。

### 8.3 列表、列与布局

- 排序要有不属于任何一列的入口（工具条「排序」卡片），全文结果与文献列表共用同一个
  排序；默认方向按键定，方向写成文字不只用箭头。
- **比较规则只有一份**：`columns.ts` 的 `sortKeyFor()` / `compareSortKeys()`，
  `App.tsx` 预计算键之后也调它，不再内联 `(a.v < b.v ? -1 : 1) * dir`。
  `sortKeyFor` 只对 `year` 标 `missing`（`created` 的空串仍按旧规则排最前，
  `starred` 的 0 是真实值不是缺失）。缺失年份在**两个方向都排最后**，
  所以这一支比较不能乘 `dir`；`tests/renderer-pure.test.ts` 把旧表达式逐行抄进
  测试做了逐值对照，并单独证明差异真实存在，`refactor-regression.test.ts` 锁住接线。
- 工具条一行放不下靠 `.toolbar > .search` 的 `min-width` 让步（其余
  `flex: 0 0 auto`），别压扁按钮。
- 中文控件被挤会站起来（min-content 是一个字宽），`.toolbar` / `.pdf-bar` 统一
  `flex-wrap: nowrap` + `overflow-x: auto` + `> * { flex: 0 0 auto }`，
  唯一让位的提示句同时给 `min-width: 0`。
- 列宽拖动在 `window` 上听 `mousemove`（把手只有 7px）、一帧合并一次、起始宽度用
  `getBoundingClientRect()` 量、落盘值按 `ColumnDef.min` 分列 clamp；拖动规则抽成
  `src/lib/useDragX.ts` 两处共用。列布局至少留一列 `fr`、列头跟着横向滚；
  落盘在 `useEffect` 里等 state 定下来，不在 `mouseup` 写闭包值。
- 列头拖动要有阈值，落点是「间隙」0..n 再换算成数组下标，指示线画在 `.col-head`
  （给 `position: relative`）而不是格子。
- 搜索有词时中间栏是结果卡片（`div.res-row`）、清空才回表格（`div.row`），
  卡片与表格行都带 `data-id`；`selected` 在 `filtered` 找不到时回退到 `docs`，
  右栏按 `d.localPdf ? 'pdf' : 'details'` 决定显示哪个页签。
- **右栏一次只渲染一个 `PdfViewer`**（`reader` 没有 `key`，跨文献复用同一组件；
  `smoke.ts` 的单 viewer 注释与 `documentScope` 都依赖它）。「打开多篇」不是多个
  reader，而是 `src/lib/openPapers.ts` 的 `OpenPaper[]`：`id / doc 快照 / page / tab`。
  `OpenPaper` 多一个 `preview` 位，固定策略是 VS Code 那一套：`openPaper`
  （所有单击入口）建预览标签，`upsertPaper` 让新预览**替换现有预览标签**、
  固定标签既不替换也不因再单击而降级，`pinPaper` 把预览就地转固定，
  `nextActivePaper` 决定关闭当前标签后落到哪篇。App 的 `activatePaper`
  把激活标签投影到 `selId / pinned / rightTab / jump`，`selected` 与 `reader`
  的语义不变，冒烟里单 `.pdf-pane`、单个右栏空态、单行 `.open` 的断言仍成立。
  **所有「打开」动作都走 `openPaper`**：文献列表行 / 搜索结果卡片
  （`onRowSelect`）、全文 / 参考文献 / 标注 / 查重 / 回收站 / PDF 内链接。
  点列表行不指定页码（`page: null`），仍按 `reading.json` 恢复上次读到的页。
  唯一例外是键盘方向键的 `selectOnly`，只 `setSelId` 不打开标签。
- **双击固定只在一处接线**：App 用 `document` 的 `dblclick` 捕获，从
  `target.closest('[data-id]')` 取文献 id 调 `pinPaper`，并排除 `.pane-right`
  （标签栏有自己的 `onDoubleClick`，详情面板不该触发固定）。各视图的行只要带
  `data-id` 就自动生效，`DocTable` / `SearchResults` / `DupesView` /
  `TrashView` 原本就有，`RefsView` / `FullTextView` 的 `.ft-row` 与 `NotesView`
  的 `.notes-row` 已补齐。双击会先派发两次 `click`（两次 `openPaper` 同一篇，
  幂等），随后 `dblclick` 才固定，顺序不要改。预览标签加 `.preview` 类，
  `panes.css` 里 `.paper-tab.preview .paper-tab-label { font-style: italic }`。
  回收站文献不在 `docs` 里，靠标签里的 `doc` 快照与 `pinned` 兜底。
  要改预览/固定规则只动 `upsertPaper` / `pinPaper`，别在各调用点各写一份。
- 标签栏是 `.pane-head` **上面独立一行** `.paper-tabs`（`flex: 0 0 auto` +
  横向滚动），不塞进 `pane-head`：和浏览器一样，「切哪篇文献」的层级在「详情 /
  PDF」这组只作用于当前文献的按钮之上，顺序不能倒过来。仍是固定高度，不会抢走
  PDF 的高度，也不挤 `PdfViewer`。标签按钮文字不能叫「详情」「PDF」「返回列表」，
  冒烟用 `find(textContent.trim()===...)` 在 `.pane-right button` 里找它们。
- 逐字段搜（`src/lib/match.ts`）标出命中的字段 + 片段 + `<mark>`，作者命中时
  改用全名显示；Unicode 折叠后的下标要映射回原串再切片。
- 批量下载并发 2–3、失败跳过、路径攒 10 条 flush 一次再末尾 flush；
  按钮写篇数，为 0 时禁用并写明原因。

### 8.4 键盘、焦点与浮层

- 一次 Esc 只关最上面一层：capture 阶段接键 → `preventDefault` + `stopPropagation`
  → 只关自己这层，浮层分支排在「退出视图」之前；`AskDialog` / `BatchEdit` /
  `RowMenu` 都别漏 `stopPropagation`，`<select>` 最容易漏。
- 工具条三张卡片与设置面板这四层的顺序是纯规则 `src/lib/overlayStack.ts` 的
  `topOverlay`（settings → columns → sort → filters），状态与事件在
  `src/lib/hooks/useOverlayStack.ts`。App 的 Esc 分支只问一次 `closeTopOnEscape(e)`，
  返回 true 就停；退出阅读视图与清多选排在后面，不属于浮层。
- ↑↓/Delete/Space/Ctrl+A 只在焦点不在 INPUT/TEXTAREA/按钮时当导航键；
  Ctrl+F 用 capture 抢（App 先注册了 bubble 监听）。
- Esc / Ctrl+A 仍由 App 统一管理，但 handler 依赖数组现在带的是
  `closeTopOnEscape`（hook 在四个浮层状态变化时重建它）、`folderId` 与 `view.kind`，
  不再逐个列 `settings` / `showCols`。少任何一个都会让闭包抓到旧值，Esc 彻底没反应。
- 改名请求带 `{ id, n }` 计数器，F2 由 App 全局认、`FolderTree` 用 effect 应答；
  没有打开文件夹、焦点在输入控件、焦点不在 `.pane-left`、或该行被筛选掉时都拒绝开框。
- `onBlur` 在冒烟里要派发 `focusout`（React 把 `onBlur` 映射成 `focusout`），
  或走 `keydown Enter` 提交路径。
- `overflow-x: auto` 会连坐 `overflow-y` 变成裁剪框，挂在按钮下方的卡片一律
  `position: fixed` 并用 `src/lib/popspot.ts` 的 `usePopSpot` 在 layout effect 里量坐标
  （下放不下往上翻、右出界往左收、resize 重算）。
- 浮层断言用 `elementFromPoint`（卡片中心点最上面那个元素是不是它），
  不用 `getBoundingClientRect`（被裁掉的卡片照样报完整矩形）。

### 8.5 图标与视觉

- 当前图标是 Mendeley 官方图形标记 + 紫→青水平渐变；改图标只动
  `scripts/make-icon.mjs` 的形状表，改色只改 paint 不动形状。
- 把「好看」变成可测的：解 PNG 像素断言四角透明、暖色像素为零、无 mask /
  dasharray；矢量和位图要真的画进 canvas 读回像素比过。
- 颜色写在 inline style 里优先级高于 class，光改 CSS 变量没用，必须删掉 inline
  那行让 `[data-theme=light]` 去翻。
- **视觉打磨是令牌驱动的**。`base.css` 的 `:root` 与 `[data-theme=light]` 各自定义
  `--radius` / `--radius-sm` / `--accent-soft` / `--accent-ring` / `--shadow-pop` / `--t`；
  选中态（`.row.sel`、`.res-row.sel`、`.folder-row.sel`）从整块 `--accent-dim`
  蓝底换成半透明 wash + `inset 2px 0 0` 竖条，活动标签用顶部竖条。主命令
  `toolbar > .reading-button` 用 accent wash 强调，但**padding 一个像素没动**——
  冒烟量的是按钮几何。`--bg-2` / `--fg` 刻意保持不变，它们是
  `shared/titleBarTheme.ts` 里系统标题栏按钮颜色的镜像，
  `tests/title-bar-theme.test.ts` 逐值盯着；改这两个值必须同步改 TS。
  焦点用 `box-shadow` ring 而非 `outline`，滚动条细化，所有过渡在
  `prefers-reduced-motion: reduce` 下关掉。`tests/visual-tokens.test.ts` 锁住
  两套主题都有令牌、浮层共用一份阴影、选中态不再回到饱和蓝。
- **第二遍打磨只动层级，不动尺寸**。列头从 `--bg-2` 换成更深的
  `--panel-head`、字距加 `0.02em`、hover 反馈、排序列用 `inset 0 -2px 0`
  下划线而不是只靠颜色；详情面板字段标签与 `.pane-head` 加字重/字距，
  「详情 / PDF」的活动按钮补一条底边；更新状态行加 `inset 2px 0 0` 竖条。
  空状态用 `.empty:not([style])` 变成虚线卡片——列表里那些紧凑提示自己
  带 inline padding，正好用 `[style]` 做免类名的例外，不必在十几个调用点
  各加一个 class。全部是颜色 / 字重 / 内阴影，几何一律没碰。
- 官方标记是别人的商标，公开分发留意使用范围。
- 窗口顶栏不再用系统那条白底英文菜单：Windows 上 `titleBarStyle: 'hidden'` +
  `titleBarOverlay` 只留系统画的最小化/最大化/关闭。原来是「34px 标题条 +
  一行工具栏」两行，现已**合并成唯一一行** `.toolbar`（固定 46px）：
  `TitleBar.tsx` 的 `TitleBar` 只渲染身份（图标、名字、`本地优先`），
  作为工具栏第一个子元素；`TitleBarControls` 在最后占 138px 给系统按钮。
  `shared/titleBarTheme.ts` 的 `TITLE_BAR_HEIGHT = 46` 必须与 `.toolbar`
  的 `height` 相等，否则系统控件垂直不对齐；色值仍是唯一一份，
  建窗时和 `config:set` 收到 `theme` 时各刷一次 `setTitleBarOverlay` /
  `setBackgroundColor`，`tests/title-bar-theme.test.ts` 断言它与
  `base.css` 的 `--bg-2` / `--fg` 逐值一致。
  合并需要约 300px：身份 176 + 控件 138。腾法是把字号/主题簇、「全量」和
  「撤销」收进「更多」（`筛选 / 排序 / 列` 实测仍放得下，留在栏上），
  计数徽标保留在栏上——冒烟的筛选测试从 `.badge` 读 `\d+ / \d+` 判断收窄
  前后数量，藏进菜单会让 `shown()` 读到 0。搜索框自动从 218 缩到约 184px，
  冒烟的一行 / 不折行 / `overflow <= 0` 判据一个没放宽。
  拖拽区只在 `.title-bar-identity`、`.toolbar > .grow`、`.title-bar-controls`
  三处——`.toolbar` 本身若设 drag，里面的浮层菜单会继承 drag 而点不动。
  非 Windows 由 preload 的 `html.custom-title-bar` class 把身份和控件占位
  一并隐藏，仍用系统标题栏。
- 默认英文菜单不能直接 `setApplicationMenu(null)`：复制、粘贴、全选、重载、
  开发者工具这些 role 快捷键挂在应用菜单上。`electron/main/menu.ts` 换成中文
  role 菜单，`autoHideMenuBar: true` 收起它；按 Alt 才会短暂出现。

### 8.6 窗口、更新、打包与分发

- 保存对话框只走 IPC：main 里 `dialog.showSaveDialog` 拿路径再 `writeFile`，
  取消返回 `null`、静默返回，不写空文件、不弹错误条。
- 窗口 bounds 与最大化在 `close` 里写、不在 `resize` / `blur` 里写，
  最大化用 `isMaximized()` 单独存，不能靠宽高猜。
- 单实例锁在建窗之前抢，`requestSingleInstanceLock()` 返回 false 时 `app.quit()`，
  `whenReady` 里也用 `alone` 标志挡一道；`--smoke` 与 `--demo` 不抢锁
  （`wantsSingleInstance(argv)` 是纯函数）。
- 第二次点击只处理「最小化」这一种不可见，用 `isMinimized()` 判断，
  别用 `!isVisible()` 把还没到 ready-to-show 的窗口强行拽出来。
- 静默检查更新失败或没有新版时回到 `idle` 什么都不显示，用户自己点按钮才如实报错；
  只做到 `available`，`downloaded` 后的重启永远由一次点击发起。
- 每个 phase 的文案把当前版本与新版本两个数字并排写出来
  （`UpdateState.current` 由主进程在 `send` 时统一带上）；`UpdateState` 只在
  `shared/types.ts` 定义一份、updater re-export。

### 8.7 破坏性操作、引导与批量反馈

- 确认框说清能不能撤回（「移入回收站可恢复」与「彻底删除不可恢复」是两种决定），
  Esc 必须是取消且与已有 Esc 逻辑不打架。
- 确认只在 App 一侧挂一份（`onMerge` / `onPurge` / `onBuild` / `onClear` 都由 App
  提供），组件里不各自 `confirm()`；只有 `PdfViewer` 的「删除标注」传一个 `confirm` 进去。
- 批量反馈走 `runBatch` / `reportBatch` 报「没做成几条」并给失败名单，
  undo 只登记真正成功的 id（按失败名单反推会误伤同名记录）。
- `batchMsg` / `importMsg` 2.5 秒自己消失、不加关闭按钮；只有 `err` 不自动消失、
  只给一个关闭。
- 引导是渲染进程里的一张卡片，只在真的缺东西时出现（无 token / 未设 PDF 目录 /
  库里没有文献），不在 `whenReady` 之前用 `dialog` 弹（那时读不到 userData）。
- 三种空态区分清楚：`docs.length === 0`（库空）、
  `filtered.length === 0 && docs.length > 0`（筛掉了）、搜索词本身；
  判断顺序写反会把「库空」说成「没搜到」。

### 8.8 文件夹

- `buildTree` 的 `walk` 递归到每一个节点都要写 `subtree`（返回之后写
  `out.slice(start)`），子树规则对每一个文件夹成立：选子文件夹带全部后代、
  拖放不允许把父拖进自己的后代。
- 拖动带「当时选中的」（拖未选中行按单行、拖已选中行按整个多选）；加入前过滤
  已在文件夹里的文献；遮罩判断看 `e.dataTransfer.types` 而不是 `files`
  （拖动中 `files` 为空）。
- 移出与加入都 `pushUndo` 反向操作；排序在 `buildTree` 里用 `byName`
  （文件夹列、加入下拉、详情面板三处共用），`numeric` 与 `sensitivity: 'base'`
  都要，子层也要排。

### 8.9 性能与测量

- 「有点卡」先量再改：`npm run perf` 用真实库、跳过 sync、只测不判；
  窗口必须真的 `showInactive()`，隐藏窗口 rAF 被节流到约 1 秒一帧，
  量到的是节流不是程序。
- 慢帧阈值用当次测量的中位数 ×2、不写死 50ms；滚动一格一格地滚
  （每次 `await requestAnimationFrame`），按键代价读 `dispatchEvent` 的同步返回耗时。
- 三档受控实验（0 篇 / 几十篇 / 上千篇）分嫌疑；排序键在比较函数外算
  （`map → sort → map`，n 次而非 n·log n 次），模块级复用一个 `Intl.Collator`，
  只为读长度别用 `filter()` 建五个数组。
- 虚拟化的收益会被全量预处理吃掉，`matchAt(i)` 按需建并缓存在 `useMemo`；
  别把力气花在没量到问题的动作上。
- 冒烟跑在真实配置上会残留 sort、第一行论文每次可能不同，
  别把「哪篇排第一」写进断言。

### 8.10 通用

- `file://` 页面用 Electron 的 `clipboard` 模块，不用 `navigator.clipboard`。
- 点空白判断用 `e.target.closest('.row')` 且行类名作参数；Esc / 批量栏只清多选
  保留正在读的论文，点空白才连右栏一起清。
- 按文档 id 贴标签（`ForDocument<T>` / `valueForDocument` / `ownerId`），
  `switchTo` 放渲染期不放 effect；取消只作废代次、不靠 `setState` 清空，
  清 state 停不了已经发出的 promise。
- 跨层 import 一个纯函数前先看它所在文件是不是真的无 DOM（EndNote XML 的
  `DOMParser` 拆在 `src/lib/importText.ts`）。`src/lib/view.ts` 的 `Entry` 必须直接从
  `importText.ts` 取，别经 `import.ts` 的转导出：后者带 `DOMParser`，一旦 `view.ts`
  被列进 `tsconfig.node.json` 白名单，node 工程就报一串 DOM 类型错误。
- 需要输入一律用 `AskDialog`；`window.confirm` 可用。
- 冒烟里取消路径要真点「取消」，别用 `window.confirm = () => false` 打桩。

### 8.11 搜索范围与参考文献

- 范围只有一份枚举 `src/lib/searchScope.ts` 的 `SearchScope`：
  `all / title / abstract / body / references`。`body` / `references`
  不走书目 haystack，由各自的视图回答，所以 `scopeHay` 对它们仍返回全字段，
  免得文献表在切过去时整张变空。
- **归一化只有一份**：`normaliseQuery(q) = trim + toLowerCase + 折叠空白`，
  书目 haystack（`scopeHay` 的所有 scope）、`savedSearchMatches`、`refsindex.ts`
  的   `searchRefs`、`RefsView` 的高亮都用它。`all` 的契约是「等于旧 `hay()`
  再折叠空白」：这是**有意放宽**，
  因为输入带两个空格时旧书目表搜不到、参考文献却能搜到。别再让某个范围
  自己写一遍 `trim().toLowerCase()`。`fulltext.ts` 的 `ftSearch` 本来就折叠空白，
  不用改它（它有 smoke 计数断言）。**所有检索 UI 都接这一份规则**：
  `SearchResults` / `TrashView` / `NotesView` / `FolderTree` / `AddByIdView` / `RefsView`，
  且 hay 与 needle 同一份归一化（只改 needle 不改 hay 会造出「折叠后反而搜不到」）。
  `SearchResults` 若传未归一化的 `query.trim()`，双空格查询能进列表却没有 `<mark>`；
  `tests/refactor-2026-11-16.test.ts` 有「旧写法确实不高亮」的对照与源码串护栏。
  折叠空白是有意放宽，动手前按 §4 测试纪律先做逐值差分。
- **近似匹配只用于书目字段；主搜索在没有精确命中时才兜底**。规则全在 `src/lib/searchMatch.ts`：
  `foldSeparators` 把字母数字与 CJK 之外的字符当词间分隔，`compact` 再去一次空格（中文
  里多打一个空格也能命中），`tokensNear` 对每个词只允许一次替换/增删/相邻交换且长度
  小于 3 不近似，`matchQuery` 要求**每个查询词都命中、至少一个词精确命中、且命中位置
  相距不超过 `词数+1` 个词**，并返回真正出现在 hay 里的 `terms` 供高亮。位置约束不能省：
  `cud` 与长摘要里的 `can` / `cut` 只差一次编辑，没有它 `qwen cud` 会把一堆无关的
  Qwen 报告一起捞出来。`allowNearFor` 由调用方对整个 haystack 算一次，
  `queryMatches` 是列表、`filterCounts`、`savedSearchMatches` 与三个局部筛选共用的唯一
  判定：主搜索、计数与保存搜索都传 `allowNearFor(...)` 的结果，回收站 / 笔记 /
  文件夹树传 `true`（列表短、不排序、没有「相近」标签，直接兜底更实用）。App 另预建
  `foldedHay`，避免每次按键对库里每篇文献各跑一遍正则。
  **不要用改 `normaliseQuery` 的办法实现近似**：`AddByIdView` 拿它对 DOI / arXiv 做
  `===` 判重，放宽会把两篇不同的文献合成一篇。
- **近似结果必须能被标记**。`matchDoc` 第 4 参接 `terms`，`markAllTerms` /
  `snippetTerms` / `authorPartsFor` 用多个词标同一字段并合并重叠区间；`SearchResults`
  从 App 收 `nearTerms: Map<id, string[]>`，卡片加 `.res-near`「相近」标签。冒烟的
  `explained === cards` 要求每张卡都有 `<mark>`，所以这里的高亮不是装饰。
- **全文与参考文献用同一套近似规则，但不碰偏移**。`searchMatch.ts` 的 `wordSpans(text)`
  用 `/[\p{L}\p{N}]+/gu` 切词并保留每个词在**原文**里的 `at/len`，`nearSpans` 复用
  `matchWords`（每词命中 + 至少一精确 + 邻近），`spanBounds` 给出覆盖全部命中词的最紧
  区间。`fulltext.ts` 的 `nearHits()` 按 `Entry` 切出该篇文本，把 `at` 加上 `e.start`
  变回 `fulltext.dat` 的绝对偏移再交给 `pageOf` / `snippetAt`；`refsindex.ts` 在 `hay`
  上匹配并用**同一个 `hay`** 切片段。两者都不改语料、不升 `version:1`、不重建缓存，
  旧索引照常加载。
  **不能用折叠副本取偏移**：`at / start / len / bounds / docAt / pageOf / snippetAt`
  全指向固定 `fulltext.dat` 的 UTF-16 位置并由 `byteAt` / `m.bytes` 双锚点锁死，副本里
  的 100 不是原文里的 100，会错文档、错页、错片段。近似路径先用「至少一个词在整篇里
  精确出现」做快速筛，词数上限 `MAX_NEAR_WORDS`。
- **全文的多词结果是三层追加，精确短语不再独占**。顺序是整短语 `body.indexOf(needle)`
  → `docsWithAllWords`（所有词在同一篇即算命中）→ `nearHits`，每层按 `docId` 去重，
  总数受 `MAX_HITS` 限额，精确结果一条不少且排在前面。旧实现整短语一命中就 `return`：
  `qwen3 te` 只在两条参考文献里连续出现，5693 篇的库只回 2 篇；`qwen3.5 te` 整短语
  零命中，反而落到 AND 回 68 篇。现在两条查询都按词的提及量回答（`300` / `64`，
  前者触到上限），差异来自 Qwen3 系列本身被更多论文引用。
- **分词只有一份定义**。`searchMatch.ts` 的 `fullTextQueryWords(needle)` 同时给
  `coverageWords`（按空格切、保留点号，`qwen3.5` 是一个词）与 `nearWords`
  （`queryTokens`，点号/连字符拆词）。`fulltext.ts` 的整短语用字面 `needle`、AND 用
  `coverageWords`、近似用 `nearWords`，`refsindex.ts` 的近似也取
  `fullTextQueryWords(needle).nearWords`。单 token 路径仍按字面 `indexOf`，把版本号
  拆成 `qwen3` + `5` 会把所有 Qwen3 论文都拉进来。
- **短词按词首匹配，且只在候选文档里扫**。`wordBoundaryMatch` 要求长度 ≥3 的词整词
  出现、<3 的词出现在词首（`te` 命中 `technical`，不再命中 `attention` 中间的 `te`）。
  `te` 在 69 MB 语料里有 56 万处，逐处全库扫描会让 `ft:search` 这个同步 handler 卡到
  1.4 秒：AND 先用长词选出候选文档，再在每篇候选里找第一个词首命中；`nearHits` 的
  anchor 也只取 ≥3 的词，结果已满 `MAX_HITS` 时不再启窗口扫描。真实库实测多词查询
  0.17–0.44 秒，与既有近义兜底同量级。
- **参考文献仍是零命中兜底**：只有短语 `indexOf`，没有 AND 路径，与书目一致。
  `fulltext.ts` 的 `nearHits` 只在 anchor 词每次出现的前后 160/200 字符窗口内切词
  （每篇最多 12 个窗口）：命中词按规则必须紧邻 anchor，窗口是**局部短语搜索**，不能
  拿它的 token 下标去和整篇的跨度比较；`MAX_HITS` 与 `skip` 集合仍由调用方给。
- **两个视图都要标近似命中**。`FtHit` / `RefHit` 加可选 `near` / `terms`；精确命中路径
  完全不变，`FullTextView` 只在 `h.near` 时用 `markAllTerms` 标词；`RefsView.Snippet`
  原来的 `indexOf(q)` 在近义片段里找不到词，改走 `terms`。`.ft-near` 标签说明这不是
  完全匹配。
- 范围控件是 `search-wrap` **内部**的原生 `<select>`，不是工具栏直属子元素、不是
  第二个 `<input>`、也不是浮层卡片。三者分别会：多一个 gap 把字号/主题挤出一行、
  打穿冒烟里 `document.querySelector(".toolbar input")` 的唯一性假设、或给
  `overlayStack.ts` 的优先级和 `overlay-stack.test.ts` 的 16 种组合再添一层。
- **同步与更新的文字不进工具栏**。`Toolbar` 是 `flex-wrap: nowrap` 的一行，
  右端字号/主题按钮必须够得着；以前两条 `.status` 是唯一能缩的子元素，
  `max-width: 44%` + 省略号让「已是最新版本」「增量同步：…共 5691 条文献」
  互相抢宽度、两条都只剩半句，且更新条的 `title` 还错写成「当前版本 x」。
  现在 `StatusBar.tsx` 在工具栏**下面**独占一行，`statusbar.css` 只有
  `white-space: normal` + `overflow-wrap: anywhere`，没有 `nowrap` / `text-overflow`
  / 固定高度；两条消息各占一行，全文永远可见。冒烟的
  `querySelector(".toolbar .status")` 已改成遍历 `.status-line`。
- 「已是最新版本」是手动点检查更新后的回答，不该挂一整场：`updateText.ts`
  的 `updateIdleDelayMs()` 只对 `not-available` 返回
  `UPDATE_NOT_AVAILABLE_VISIBLE_MS`，`App.tsx` 据此起定时器并在卸载或下一次
  状态推送时清掉；下载中/已就绪/报错必须留着等人处理。
- **省略号只决定版式，不决定读者能读到多少**。全站 19 条 `text-overflow: ellipsis`
  的元素都带全文 `title`：结果卡的标题/作者/命中字段用
  `match.ts` 的 `partsToPlainText()` 把带 `<mark>` 的分段拼回整句，全文/参考文献
  命中片段、标注句子、右键菜单头、按 ID 添加的候选标题、命名模板、已保存视图名、
  阅读器提示各补自己的全文；`tests/truncation-fallback.test.ts` 逐个锁住接线。
  长散文（`.res-title`、`.ft-snip`、`.notes-text`）改 `-webkit-line-clamp: 2`
  两行显示并保留 tooltip。结果卡是固定高度的虚拟行：`.res-row` 的
  `overflow: hidden` 曾把第 4 行**静默**吞掉，现已删掉，`--res-h` 提到
  `6.4rem` 留出两行标题的空间，每个子块自己 clamp，溢出会显示省略号而不是消失。
  结果卡没整块改两行 clamp，是为了不破坏 `useVirtualizer` 的固定行高。
- `body` 就是已有的全文视图：选它切 `view.kind === 'fulltext'` 并把 `query` 单向复制成
  `ftQuery`；「全文」按钮也反向把 `scope` 设成 `body`，两处不能各说各话。
  清空搜索时把 `body` 复位成 `all`，别让下拉写着「PDF 正文」而中间是文献表。
- `references` 走 `electron/main/refsindex.ts`：只读每篇 PDF **末尾最多 20 页**，
  用 `src/lib/refly.ts` 的 `isRefHead` 找 References 标题，把之后的文本存进
  `<userData>/library/references.json`（`{version:1, entries:{[docId]:{mtime,size,text,page}}}`）。
  按 `mtime+size` 增量，单篇失败记 `skipped` 继续；`refs:build` 推 `refs:progress`，
  `refs:search` / `refs:status` 是同步小结果。**全文索引只取前几页，搜不到参考文献**，
  两套索引不要合并，也不要去改 `fulltext.ts` 的格式。
- 首次选 `references` 且索引为空时自动建一次，渲染层查询按 250ms 防抖；
  `buildRefsIndex` 的 IPC 是长任务，进度必须显示，别让一次等待看起来像卡死。
- 篇内查找也接这一份归一化：`usePdfFind` 的 `key`、`needle` 与长度判定都用
  `normaliseQuery`，查找框仍显示读者输入的原词。最短词长具名为
  `MIN_FIND_QUERY_LENGTH = 2`（要逐页问 pdf.js 取文本），与 `refsindex.ts` 的
  `MIN_QUERY = 1`（短表内精确 `indexOf`，中文单字检索）有意不同，别把两者合并。
- 范围目前是**会话内状态**，没有写进 `SavedSearch` / `AppConfig`。要持久化时
  `SavedSearch.scope` 必须可选并兼容旧配置（照 `s.filters?.filter(` 的写法），
  且别动冒烟锁住的 `filters: [...filters]` / `savedSearchMatches(` 等源码串。
- `references` 没有自己的 `View`，只换**文献表那一格**：条件分支放在
  `query.trim() ? <SearchResults> : <DocTable>` 这一层，不能放在
  `view.kind === 'add' ? …` 链的链首，否则查重 / 导入 / 回收站 / 全部标注全部被吞。
  另有 `scope === 'references' && view.kind !== 'library'` 的复位 effect 兜住所有
  `setView` 入口；`applySearch` 也要显式回 `LIBRARY` + `all`，否则已保存搜索的高亮
  和计数描述的是一张不在屏上的表。
- `refsindex.ts` 的 build 有**进程内 busy 闸门**（渲染层另有一个 `useRef` 闸门，
  防先结束者提前清进度条）；每 20 篇 checkpoint 写一次盘，`finally` 再写一次，
  进度按 200ms 节流且回调抛错要吞掉。跑完按 `candidates()` 的 id 集合 prune，
  否则已删文献的参考文献文本会一直被搜到、`indexed` 还能大于 `total`。
  单字查询（`MIN_QUERY = 1`）是正常中文检索，渲染层那道 `q.length < 1` 要与它一致。
- 渲染层的 refs 查询必须带 `live` 守卫和 `.catch`：清 timer 只挡住还没发出的请求，
  慢 IPC 回来会拿旧词结果盖住新词。`refs:search` / `refs:status` 返回 `{error}`
  或直接 reject 都要进 `refsError` 显示在面板上，**不能**用
  `Array.isArray(r) ? r : []` 或空的 `.catch(() => undefined)` 把故障伪装成
  「没找到」。后者会让面板留着旧命中且一句话不说；两条 catch 都带
  `live`（搜索那条还比对了归一化后的词）再写 `refsError`。
- `RefEntry.hay` 是 `normaliseQuery(text)` 的副本，**匹配与切片段都在它上面做**：
  从 `toLowerCase()` 的串取偏移、却去切原串，遇到 `İ`（小写变两个 code unit）
  会整体偏掉；边折叠边找也会让第二个命中之后的偏移全错。字段可选，旧缓存
  没有它时回退到 `normaliseQuery(e.text)`，不要求重建索引。
- `searchRefs` 对每篇循环 `indexOf` 累积命中（每篇上限 8、全局 200），
  `RefsView` 的 `hs.slice(0, 4)` /「还有 N 处」才不是死代码。推进游标用
  `at + Math.max(1, needle.length)`，单字查询才不会死循环。短文本仍可能
  四条的片段完全相同（±80 的窗口覆盖了全文），要区分得让 `RefHit` 带上
  命中在片段内的偏移，尚未做。
- **PDF 查找栏的位置**：原来 `.pdf-find` 是 `.pdf-body` 里的 `position: absolute`
  浮层，压住页面右上角正文。现改为 `.pdf-bar` 与 `.pdf-body` 之间的**独立一行**
  （`flex: 0 0 auto`、底边框、`--panel-head` 底），代价是打开时页面下移一行，
  换来正文一个字都不被盖住。关键是它在 `.pdf-scroll` **外面**：页顶偏移、
  命中矩形、连续滚动都只在滚动盒内部量，这一行不会动到任何坐标；冒烟的
  「find bar placement」断言改成量两个矩形是否 `overlap === false`
  且 `b.top - a.bottom` 在 ±2px 内，判据没有放宽，只是换了设计。
- **PDF 查找栏**：`usePdfFind` 每页命中就 `publish` 画高亮，早期实现却要等全篇
  扫完才 `setFindOpen(true)`，于是几十到上百页的论文会先出现橙框、很久之后才有
  写着词的查找栏（`box: 0`）。首次 publish 已证明词就在这篇里，此时就开框；
  冒烟的 `the marks come with a box` / `shutting the box` 两条即此项回归。

---

## 9. 当前的取舍与边界

这些是当下成立的限制，写下来免得被误读成 bug：

- token 以明文 JSON 存在 `<userData>`，没有用 `safeStorage`。改它要同时处理
  `scripts/get-token.mjs` 写的旧文件、导入的 `token.json` 与回退路径；没有迁移就改，
  结果是「莫名要求重新授权」。
- `shared/atomicJson.ts` 的临时名固定为 `<file>.tmp`。本进程内所有 JSON 写都在主线程
  串行，且自检会拒绝第二份程序共写同一份 config；这不是并发安全的实现，不要把它
  拿去给多进程场景用。
- `src/App.tsx` 仍是组装层里的一个大文件，`Toolbar` 的 props 很多。已抽出
  `runBatch`（`lib/batch.ts`）、浮层栈（`lib/overlayStack.ts` +
  `hooks/useOverlayStack.ts`）、合并补字段（`lib/mergeFields.ts`）与批量预算
  （`lib/budgets.ts`），每一处都是先配纯规则单测再改接线。剩下的 `setLib`
  状态簇与 Esc 之后的键盘导航仍在 App 里；拆它们要连带重排冒烟里大量 UI
  驱动与接线断言，同样先补行为测试再动手。
- `smoke.ts` 只抽走了六个不碰窗口、不碰真实库、不读自身源码的纯断言块，入口、
  `cfgSnapshot`、`restoreSmokeConfig`、共享 `expect`/`fails` 与末尾汇总都没动。
  剩下两段 UI 驱动链、读真实库的块、读 smoke.ts 自身源码的块、以及配置收尾块
  都还留在入口：它们共享闭包状态或依赖源码串计数，拆之前要先给这些依赖解耦。
  新增子模块只能用静态 import，且必须与 `smoke.ts` 同级，否则产物里多一层目录
  会让 `__dirname` 定位的 preload / renderer / 仓库根全部失效。
- `src/styles.css` 是十二行 `@import`，规则逐字留在 `src/styles/` 的分片里。
  顺序就是层叠顺序：改动时先按顺序拼接与 `HEAD` 逐字节比对，别为了归类去重排。
- 主进程侧 `system`、PDF 写入、同步 pull、标注与阅读位置四类都有行为单测；
  渲染层浮层优先级有纯规则单测（Esc 逐层关闭的 UI 行为仍由 smoke 实测）。
  `export.ts` / `importText.ts` / `updateText.ts` / `doctypes.ts` 的纯规则在
  `tests/pure-modules.test.ts` 里有纯 Node 用例。
  `fulltext.ts` 的表形状、偏移定位、页码与 worker 故障判定已下沉到
  `shared/fulltextRules.ts` 并配固定输入单测；两个索引共用的文件判定、片段
  与进度在 `shared/indexedFileRules.ts`。仍只靠 smoke 源码串断言与真实库自检
  守着的是 `fulltext.ts` 的写入状态机（`busy` / `deferred` / `pending`）与
  `App.tsx` 剩余状态簇。
- 主窗口 `sandbox: false`（授权窗口是 `true`）：preload 只用 Electron API，
  统一沙箱前要确认没有依赖 Node 的 preload 路径。
- `store.ts` 里五个 JSON 没有 schema 版本与迁移：结构校验失败一律当成「无缓存」，
  随后一次写入会覆盖它。改动存储结构时要自己补迁移或损坏保留。
- 只构建 Windows `--win --x64`；跨平台按是否真有人要来定。
