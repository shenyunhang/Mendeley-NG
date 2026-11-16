# Mendeley NG 架构实现分析报告

> **分析对象**：`D:/mendeley-ng`（本地优先的 Mendeley 桌面客户端，Electron 33 + React 18 + pdf.js 4.10）
> **分析日期**：2026-11-16
> **验证**：`typecheck`、550 个单测、`npm run build` 均通过；代码与文档行号为分析时定位
> **结论先行**：磁盘事实是唯一真相；分层依赖严格单向，纯规则层可三端共用与被单测穷举。代价是 `App.tsx` 2720 行、`smoke.ts` 11712 行仍是高耦合区间，五份 JSON 无 schema 版本与迁移，原子写不是并发安全的。

---

## 1. 仓库总览与职责分配

### 1.1 规模与依赖

| 维度 | 事实 | 证据 |
| --- | --- | --- |
| 代码量 | TS/TSX 合计 40,433 行；主进程 32 个 `.ts`、渲染层 71 个 `.ts` + 27 个 `.tsx`、shared 16 个 `.ts`、单测 16 个 `.test.ts` | `find … -exec wc -l` |
| 运行时依赖 | 只有 `electron-updater`；React / pdf.js / Vite / Vitest 全在 devDependencies（打包时由 electron-vite 内联） | `package.json:23-41` |
| 构建 | `electron-vite build` 三段（main / preload / renderer）→ `scripts/copy-worker.mjs` 补 pdf.js worker | `package.json:15`、`electron.vite.config.ts` |
| 验证 | `typecheck`（两个 tsconfig）→ `npm test`（Vitest，纯 Node）→ `npm run build` → `npm run smoke`（真实窗口） | `HANDOFF.md:126-146` |
| git 跨度 | 322 提交，2026-10-30 → 2026-11-16，18 天，单分支 `main` | `git log --all --reverse` |

### 1.2 分层判断（按职责而非目录名）

```
展示层      src/App.tsx + src/components/*.tsx + src/styles/*.css   持有状态、渲染 JSX、接收用户输入
纯规则层    src/lib/*.ts + src/lib/hooks/*.ts                     无 React/DOM 的纯函数；hooks 是状态簇
基础层      shared/*.ts                                          三端共享：类型、常量规则、原子写、安全策略、分页与队列
协议层      electron/main/ipc/*.ts + electron/preload/index.ts   IPC 注册与白名单暴露；是边界不是业务
领域层      electron/main/*.ts                                  有状态：同步、REST、缓存、全文/参考文献索引、窗口、自更新
外部        Mendeley REST / Crossref / arXiv / GitHub Releases
```

`shared/` 是真正的基础层（没有任何业务对象的实现，只有规则），`src/lib/` 是"同构纯规则层"——物理上在 `src/` 下，但被主进程、冒烟、单测三处 import。`HANDOFF.md:228-232` 把它写成了约定：*「`App.tsx` 与 `src/lib/hooks/` 持有状态；`src/lib/` 与 `shared/` 是纯规则，不碰 React / DOM，所以主进程、冒烟和单测都能直接喂假时钟与手控 promise 去验证」*。

---

## 2. 各层职责表

### 2.1 基础层 `shared/`（16 个文件）

| 文件 | 职责 | 关键点 |
| --- | --- | --- |
| `types.ts` | 唯一领域模型与常量源（337 行） | `Doc` / `Folder` / `AppConfig` / `UpdateState` / `DEFAULT_FT_PAGES`；`HANDOFF.md:236`「类型只在 `shared/types.ts` 改」 |
| `pathPolicy.ts` | 全部不可信路径/URL/配置的校验（174 行） | `canServePdf` / `resolveInside` / `safeConfigPatch` / `isSafeExternalUrl`；平台可注入 |
| `atomicJson.ts` | tmp + rename 原子写 | 5 行实现，被 store / fulltext / refsindex 复用 |
| `libraryReconcile.ts` | 同步写盘前的三方裁决 | `started` / `proposed` / `current` / `trashedIds` 四份快照 |
| `librarySync.ts` | 把云端回答变成同步提议的三条纯规则 | 增量语料、保住文件夹归属、保住本地 PDF 路径 |
| `paged.ts` / `filePages.ts` | 通用分页器 + `/files` 的领域解释 | marker 是文件 id；整页都是见过的 id 就停 |
| `fullTextPages.ts` / `clamp.ts` | 跨 IPC 的页数预算 / 纯夹取 | 「一份规则」，两端不各写 `Math.min` |
| `syncQueue.ts` | 并发同步串行化 | 失败不污染队列 |
| `failures.ts` | 具名静默失败两道门 | `ignoreFailure` / `reportFailure` + sink 可审计 |
| `uniquePdfPath.ts` | `flag:'wx'` 原子占名 | 防两个并发导入互相覆盖 |
| `userAgent.ts` | Cloudflare 1010 的 Chrome UA | 所有请求含 `/oauth/token` 都要带 |
| `wordCoverage.ts` / `text.ts` / `shortDate.ts` | 文本与格式化纯规则 | 无副作用 |

`shared/types.ts` 里**出现领域词汇**（`Doc`、`AppConfig`）不构成越界——它就是领域模型的唯一声明处，其余 `shared/*` 只 import 类型，不 import 实现。

### 2.2 领域层 `electron/main/`（有状态）

| 文件 | 职责 | 关键点 |
| --- | --- | --- |
| `index.ts`（142 行） | 只决定「这次是哪一种启动」 | 单实例锁、协议、`--smoke/--demo/--perf` 分支；注释自称 *"The entry point, and nothing else"* |
| `library.ts`（138 行） | 同步编排 | 60s 水印重叠、每次拉 `/trash`、写盘前重读 `library.json` |
| `mendeley.ts`（499 行） | REST 客户端 | `?view=all`、`folder` content-type、`POST /documents` 裸字节、UA |
| `store.ts`（158 行） | 五个 JSON 缓存的读写 | `saveConfig` 内联原子写是刻意例外 |
| `fulltext.ts`（1057 行） | 追加式正文索引状态机 | `bytes` 锚点、busy 队列、format/budget 作废 |
| `refsindex.ts`（405 行） | 参考文献索引 | mtime+size 增量、checkpoint、prune |
| `ftops.ts` / `pdfindex.ts` / `pdfname.ts` | 索引驱动 / 本地 PDF 匹配 / 命名模板 | 薄适配 |
| `window.ts` / `instance.ts` / `updater.ts` | 窗口记忆、单实例、自更新 | `sandbox:false`、`contextIsolation:true` |
| `auth.ts` / `lookup.ts` | OAuth 窗口 / Crossref+arXiv | 外部集成 |
| `smoke*.ts` | 端到端自检（8 个文件） | 动态 import 成独立 chunk |

### 2.3 协议层 `electron/main/ipc/` + preload

`ipc/index.ts:22-29` 是聚合器：

```ts
// electron/main/ipc/index.ts:8-20
/**
 * Every channel the renderer can call, registered in one place.
 *
 * They used to be a flat list of forty-odd `ipcMain.handle` calls at the
 * bottom of the entry point, next to the window and the sync ...
 * The order matters once: the full-text index has to be initialised before
 * anything can answer `ft:status`, so `registerIpc` is called after that ...
 */
export function registerIpc() {
  registerLibraryIpc(); registerSystemIpc(); registerDocsIpc()
  registerMarksIpc();   registerRefsIpc();   registerFilesIpc()
}
```

六个域共注册 59 个 channel（library 6 / system 13 / docs 14 / marks 11 / files 9 / refs 3），`updater:*` 三个由 `initUpdater()` 单独注册（`electron/main/updater.ts:104,139,156`）。**没有参数化工厂**：各域直接 `ipcMain.handle`，聚合器只是有顺序的手工调用——这是刻意的"薄"，因为域之间无共享前置条件，抽象一层反而会隐藏顺序依赖。

### 2.4 展示层

`src/App.tsx`（2720 行）是组装层，`src/lib/hooks/` 的 19 个 hook 按「谁跟谁一起变」持有状态簇（`HANDOFF.md:231-232`）。`src/components/PdfViewer.tsx`（1523 行）只留缩放、翻页、拖选与 JSX，几何 / 位图 / 文本 / 查找 / 选区拆到 `src/lib/pdf*.ts`。

---

## 3. 分层成立的证据

### 3.1 依赖方向单向

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `shared/**` 是否反向 import `electron/main` 或 `src/` | **无** | 全仓 Grep 无匹配 |
| `electron/main/*` 是否反向 import `ipc/*` | 仅 `index.ts:16` 一处（入口聚合，正当） | `import { registerIpc, setDemoMode } from './ipc'` |
| `ipc/*` 之间是否互相 import | **无** | 六个域各自独立 |
| 主进程 import `src/lib/*` | 有 34 处，但**逐个列进白名单** | `tsconfig.node.json:21-59` |

主进程跨到 `src/lib/` 是唯一"物理越界"，但它被编译配置显式授权且被约束为无 DOM：

```json
// tsconfig.node.json:5-9, 21-59
"lib": ["ES2022"],              // 故意没有 DOM
"include": [
  "electron/**/*.ts", "shared/**/*.ts", "tests/**/*.ts",
  "src/lib/annotationMerge.ts", "src/lib/refly.ts",
  "src/lib/searchScope.ts", "src/lib/view.ts", ...
]
```

`src/lib/annotationMerge.ts:16` 自述 *"Nothing here touches the DOM, React, Electron or the network"*；`HANDOFF.md:603-606` 还专门记了一条雷区：`view.ts` 的 `Entry` 必须直接从 `importText.ts` 取，不能经 `import.ts` 转导出（后者带 `DOMParser`，会把 DOM 类型拉进 node 工程）。主进程对 `src/lib/` 的复用由编译配置显式授权且被约束为无 DOM，依赖方向仍单向。

### 3.2 复用证据（同一基础规则被多个上层使用）

`shared/fullTextPages.ts` 同时被 `electron/main/fulltext.ts:11`（索引构建）、`src/lib/pageBudgetCommit.ts:4`（设置面板）、`src/lib/hooks/useConfig.ts:6`（开机恢复）、`electron/main/smoke-budget.ts:6`（自检）引用；`shared/clamp.ts` 被 6 处引用；`shared/paged.ts` 被 `mendeley.ts` 与 `filePages.ts` 两处不同语义的调用方复用。

### 3.3 扩展点

- `collectPaged<T>(fetchPage, limit, maxPages, onPage)` 把网络注入为函数参数（`shared/paged.ts:13-17`），领域语义由 `shared/filePages.ts` 的 `observe` 包装提供——**适配器插槽**。
- `createSyncQueue<T>(run)` 把同步 runner 注入（`shared/syncQueue.ts:14-24`），测试可手控 promise 固定交错顺序。
- `setFailureSink()` 把告警出口注入（`shared/failures.ts:52-65`），冒烟可审计"哪些失败被吞了"。
- `pathPolicy` 的四个函数都带 `platform: Platform = host()` 尾参（`shared/pathPolicy.ts:21-23`），在任何 runner 上都能验证 Windows 路径语义。

---

## 4. 层间结合机制（声明 → 组合 → 绑定 → 执行）

| 机制 | 声明在哪 | 组合/解析在哪 | 绑定/执行在哪 |
| --- | --- | --- | --- |
| **IPC 契约** | `src/global.d.ts:26-30` 的 `interface Api`（64 方法） | `electron/preload/index.ts:17` `import type { Api }` | `preload:22` `const api: Api = {...}` 编译期校验 → `:219` `contextBridge.exposeInMainWorld('api', api)` |
| **Window ambient** | `src/window.d.ts:1-14` `declare global { interface Window { api: Api } }` | 与 `global.d.ts` 分离 | 主进程 TS 工程无 DOM，`src/window.d.ts:3-7` 注释写明分离理由 |
| **按域注册** | 各 `ipc/*.ts` 内 `ipcMain.handle('域:动作', …)` | `ipc/index.ts:22-29` 顺序聚合 | `index.ts:138` `registerIpc()` 在模块顶层同步执行（先 `initFt()`） |
| **配置写入** | `src/lib/configWrite.ts:21-23` `setConfigWriteReporter` | App 注册 reporter | `writeConfig()` 统一 `.catch` 上报，二十多处调用点不再各自吞 |
| **smoke 动态加载** | `index.ts:91-93` `await import('./smoke')` | `electron.vite.config.ts` 的 `chunkFileNames` 保持 chunk 与 `index.js` 平级 | 崩溃时 `smoke.restoreSmokeConfig()`（`index.ts:103-108`） |
| **规则下沉** | `shared/fullTextPages.ts` | 渲染层 `pageBudgetCommit` / 主进程 `fulltext` 同时 import | `config:set` 里同步 `setFullTextPages`（`ipc/library.ts:52-64`） |

**唯一契约的由来**（`src/global.d.ts:1-8` 注释）：历史上 preload 与渲染层各写一份 `Api`，已经漂移过一次——`openExternal` 被声明成 `void` 而 channel 返回 Promise。现在用显式注解 `const api: Api`（不是 `satisfies`，因为后者允许悄悄多出渲染层看不到的方法），缺方法、多方法、签名不符都是编译错误。程序化比对两份文件的 64 个方法名，差集为空。

---

## 5. 数据流：一次操作如何贯穿各层

### 5.1 链路 A：点「同步云端」→ 文献落盘

```
用户点击（src/components/Toolbar.tsx）
  → ① useLibrary.sync(full)                         src/lib/hooks/useLibrary.ts
  → ② window.api.sync(full)                        electron/preload/index.ts:24
  → ③ ipcMain.handle('library:sync')               electron/main/ipc/library.ts:47
  → ④ createSyncQueue(pull) 串行化                  shared/syncQueue.ts → electron/main/library.ts:44
  → ⑤ Mendeley REST：?view=all / /trash / /files   electron/main/mendeley.ts + shared/filePages.ts
  → ⑥ librarySync 三条纯规则生成「提议」             shared/librarySync.ts
  → ⑦ reconcileSyncWrite(started, proposed, current, trashedIds)   shared/libraryReconcile.ts:31
  → ⑧ atomicWriteJson / saveLibraryFromSync         electron/main/store.ts + shared/atomicJson.ts
  → ⑨ 回推 sync:status → 渲染层 useLibrary 合并      electron/main/window.ts
```

第 ⑦ 步：`electron/main/library.ts:103-109` 在写盘前重读磁盘：

```ts
const current = loadLibrary()
const finalDocs = reconcileSyncWrite({
  started: prev?.docs ?? [],
  proposed: docs,
  current: current?.docs ?? null,
  trashedIds
})
saveLibraryFromSync(finalDocs, folders)
```

一次拉取可跑数分钟，期间用户可能移入回收站、导入 PDF、打星标。云端答案只是**提议**，不是覆盖；`shared/libraryReconcile.ts:50-57` 做字段级三方合并（本地改过、云端没改的字段归本地）。

### 5.2 链路 B：拖入一个 PDF → 全文可搜

```
拖放（src/App.tsx）
  → doc:importPdf                     electron/main/ipc/docs.ts:48
  → uniquePdfPath: flag:'wx' 占名      shared/uniquePdfPath.ts:42-47
  → PDF 裸字节 POST /documents        electron/main/mendeley.ts（Content-Disposition 头）
  → indexAdded(doc)                   electron/main/ipc/files.ts
  → ftops.append → wasVoid 判定       electron/main/ftops.ts:84-88
  → fulltext.append / startBuild      electron/main/fulltext.ts（busy 队列 + pending）
  → ft:progress → 渲染层 useFullText  electron/main/window.ts
  → ftEpoch 在 building 由 true→false 时 +1，重跑搜索   src/lib/hooks/useFullText.ts
```

### 5.3 链路 C：打开 PDF → 高 DPI 位图

```
mendeley://pdf/<path>（src/components/PdfViewer.tsx）
  → protocol.handle('mendeley')        electron/main/index.ts:58-74
  → canServePdf(candidate, roots, knownFiles)   shared/pathPolicy.ts:87-100
  → 403 或 net.fetch('file:///…')       electron/main/index.ts:70-73
  → pdf.js getDocument → viewport(dpr) → canvas 后备缓冲
  → pdfcache.warm(key)                 src/lib/pdfcache.ts:90-103
  → LRU key = 页:scale:dpr            src/lib/pdfgeom.ts:135
```

---

## 6. 校验 / 守护体系（五层）

| 层 | 守什么 | 代码证据 |
| --- | --- | --- |
| ① 编译期契约 | preload 必须不多不少实现 `Api`；新增 `AppConfig` 字段必须显式决定是否可写 | `electron/preload/index.ts:22` `const api: Api`；`shared/pathPolicy.ts:109-130` `satisfies Record<keyof AppConfig, true>` |
| ② 进程边界 | 路径、URL、导出文件名、配置键类型；`../`、绝对路径、盘符相对、UNC、NUL 整批拒绝 | `shared/pathPolicy.ts:49-56` `resolveInside`、`:62-70` `isSafeExternalUrl`、`:149-174` `safeConfigPatch`；调用点 `ipc/system.ts:116-126`、`:266-276`、`ipc/library.ts:52-64` |
| ③ 存储一致性 | tmp+rename 原子写；`bytes` 锚点与 entry 表同一次 `saveMeta`；索引作废分 `format`/`budget`；busy 互斥与 pending 队列 | `shared/atomicJson.ts:7-11`、`electron/main/fulltext.ts:515-521`、`:303-308`、`:854-857` |
| ④ 语义裁决 | 云端提议不能覆盖在途本地编辑；已回收的文献不能复活；并行同步不能互踩水印 | `shared/libraryReconcile.ts:31-75`、`shared/syncQueue.ts:17-23`、`shared/filePages.ts:36-44` |
| ⑤ 行为回归 | 16 个 Vitest 文件 550 个纯 Node 用例 + 主进程 handler 替身测试；`npm run smoke` 真实窗口端到端；CI / release 两道产物门禁 | `vitest.config.ts:15`、`tests/main-ipc-system.test.ts`、`scripts/verify-build.mjs` |

**分层在数据侧的体现**：`shared/` 的通用工具（原子写、分页、夹取）不知道"文献"是什么；语义由领域层解释（`filePages.ts` 才知道 marker 是文件 id、`fullTextPages.ts` 才知道默认 3 页）。`HANDOFF.md:324-326` 把这条写成纪律：*「跨 IPC 的规则（页数预算、位图尺寸、夹取、延时、静默失败、路径策略）也只留一份，别在调用点手抄」*。

---

## 7. 架构评估

### 7.1 优势

1. **依赖方向干净且被编译配置强制执行**。`shared/` 零反向依赖；主进程复用 `src/lib/` 纯函数必须先进 `tsconfig.node.json` 白名单，而该工程的 `lib` 只有 `ES2022`（无 DOM），任何把 `document`/`window` 带进来的改动立刻编译失败（`HANDOFF.md:603-606` 记了这个坑）。
2. `e419fda` 一次提交引入 `shared/pathPolicy.ts` + `vitest.config.ts` + 3 个测试文件（3561 行），把过去只能靠 12k 行真实窗口冒烟验证的规则下沉成纯 Node 用例；`tests/main-ipc-*.test.ts` 用 `vi.mock('electron')` 捕获 `ipcMain.handle` 后直接调用 channel，测的是「channel 回答什么」而不是「源码里有没有那一行」。
3. **信任边界收在一处**。`contextIsolation:true` 只隔离代码不校验数据——`e419fda` 的提交信息原话是 *"Context isolation isolates code, it does not validate payloads"*。所有不可信输入集中在 `shared/pathPolicy.ts`，且平台参数可注入，`tests/security.test.ts` 49 个用例可在 Linux runner 上验证 Windows 语义。
4. **一份规则的纪律有回归测试兜底**。`ab086b5` 把页数预算下沉到 `shared/` 时，同时在 `smoke.ts` 写了 190 个输入的旧规则逐值差分断言，并单独证明「旧的两条规则确实会不一致」——`HANDOFF.md:300` 把这套方法固化为约定。

### 7.2 代价

1. **两个高耦合区间未拆完**。`src/App.tsx` 2720 行仍持有 `setLib` 状态簇与 Esc 之后的键盘导航；`electron/main/smoke.ts` 11712 行仍有两段 UI 驱动链、读真实库的块、读自身源码的块。`HANDOFF.md:682-690` 明说拆它们要「连带重排冒烟里大量 UI 驱动与接线断言」，属于已知技术债而非疏忽。
2. **五份 JSON 无 schema 版本与迁移**。`electron/main/store.ts` 结构校验失败一律当成「无缓存」，随后一次写入会覆盖它（`HANDOFF.md:701-702`）。这是用"宁可重建"换实现简单，代价是损坏的缓存无法保留现场。
3. **原子写不是并发安全的**。`shared/atomicJson.ts:7-11` 的临时名固定为 `<file>.tmp`；本进程内所有 JSON 写都在主线程串行，且自检拒绝第二份程序共写同一份 config。`HANDOFF.md:679-681` 明确写了「不要拿去给多进程场景用」。
4. **源码串断言的维护成本**。`electron/main/smoke.ts:11402-11404` 靠 `storeSrc.includes("cfgFile() + '.tmp'")` / `!storeSrc.includes('fs.writeFileSync(cfgFile(),')` 守护两处刻意例外；`HANDOFF.md:292-293` 要求重构时同步校正断言且不放宽判据。这类断言便宜，但把"改代码"和"改文档化约定"绑成了一件事。
5. **`smoke` 无法进 CI**。它需要真实库、真实 PDF 和一个真正显示的窗口，托管 runner 给不出诚实的帧耗时，所以最重的回归只能本地跑（`HANDOFF.md:162-163`）。

---

## 8. 结论与优化方向

分层把「云端只是同步源、磁盘才是真相」这条产品约束翻译成可执行的结构：领域层与外部世界打交道并产生「提议」，基础层的纯规则裁决，协议层把不可信输入挡在门外，纯规则层因为无 DOM 而可以被三端共用与被单测穷举。

分析识别出的六个优化方向：

| 方向 | 具体问题 | 风险 |
| --- | --- | --- |
| 攻击面 | `ipc/files.ts:116-123` 的 `pdf:read` 注册了但 preload 未暴露、渲染层零调用，且读任意路径不过 `pathPolicy` | 极低（删死代码） |
| 归一化漂移 | `SearchResults.tsx:104` 用 `query.trim()`，列表用 `normaliseQuery`（多折叠空白），双空格查询能命中却不高亮 | 低（单行 + 补断言） |
| 故障可见性 | `App.tsx:294/339` 的 refs 查询直接 reject 时被 `.catch(() => undefined)` 空吞，`refsError` 不显示 | 低（两行） |
| 规则重复 | `shared/fullTextPages.ts:31` 手写夹取而未复用 `shared/clamp.ts`；三个组件各写 `trim().toLowerCase()` | 低 / 中（需差分测试） |
| 构建脚本 | `.github/workflows/ci.yml:59-97` 与 `release.yml:107-145` 的 39 行产物校验逐字重复；`scripts/start.mjs` 与 `demo.mjs` 启动样板重复 | 中（抽公共脚本） |
| 测试缺口 | `export.ts` / `importText.ts` / `updateText.ts` / `doctypes.ts` 有实质纯逻辑但无纯 Node 单测 | 极低（只加测试） |

> 相关文档：[架构实现分析 HTML](./mendeley-ng架构实现分析.html) · [架构演化分析](./mendeley-ng架构演化分析.md) · [第一性原理与设计巧思分析](./mendeley-ng第一性原理与设计巧思分析.md)
