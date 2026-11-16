# Mendeley NG 基础层与领域模型演化分析报告

> **分析对象**：`D:/mendeley-ng` 全量 git 历史
> **依据**：322 个提交，2026-10-30 → 2026-11-16（18 天），单分支 `main`，远端 `github.com/shenyunhang/Mendeley-NG`
> **方法**：`git log --all --reverse` 全量时间线 → 按日期分阶段 → 对关键提交逐个 `git show --stat` 与逐文件 diff → 与 `HEAD` 源码交叉核对
> **核心发现**：这不是一条"功能堆到不能再堆于是重构"的曲线，而是一条**反复把「在调用点手抄的规则」下沉到 `shared/`、把「混在入口里的职责」迁移到独立模块**的收敛曲线。18 天里发生了三次范式级切换：`af4f4c3` 单体入口拆成六域、`f864926` 八个布尔标志收敛成单一 `View` 联合类型、`e419fda` 从「12k 行真实窗口冒烟是唯一回归」切换到「纯规则 + 519 个纯 Node 单测 + CI 门禁」。每一次都由**领域里踩到的具体坑**反向驱动基础层长出新能力。

---

## 1. 演化时间线总览

按日期统计的提交密度直接画出了节奏：

| 日期 | 提交数 | 阶段 | 主导动作 |
| --- | ---: | --- | --- |
| 2026-10-30 | 55 | A 奠基与功能铺开 | 一个单体 `index.ts` + 一个 `App.tsx`，从 v0.1.3 冲到 v0.1.11 |
| 2026-10-31 | 58 | B 体验打磨与索引韧性 | 全文索引可中断、空态解释、图标迭代、v0.1.12→v0.1.26 |
| 2026-11-01 | 43 | C 单实例、索引自审与性能 | 单实例锁、索引文件本身审计、按键主线程耗时、v0.1.27→v0.1.46 |
| 2026-11-02 | 53 | **D 决定性拆包** | `af4f4c3` 拆主进程、`c999aed` 抽四个 hook、`f864926` 单一 View |
| 2026-11-03 | 23 | E 产品叙事与状态新鲜度 | README/HANDOFF 重写、不再回写启动时读到的配置 |
| 2026-11-04 | 8 | F 状态簇继续外移 | `useSelection` / `usePaneWidths` / `useExport` |
| 2026-11-05 | 24 | **G 共享规则运动** | 页数预算、位图尺寸、延时、文案、合并规则逐个下沉到 `shared/` |
| 2026-11-06 | 20 | G 续 | 具名失败门、单一 clamp、单一引文 key stem |
| 2026-11-07 | 21 | H 正确性与第五轮评审 | 不复活回收站论文、修 `/files` 分页、十五项缺陷修复 |
| 2026-11-08 | 5 | **I 信任边界与单测地基** | `e419fda` 硬化 IPC + Vitest 地基；`be15f20` 文档重写 |
| 2026-11-09 | 8 | J 可验证性收尾 | 拆 smoke/CSS、handler 行为测试、浮层栈单一规则、视口附近重绘 |
| 2026-11-10 | 1 | K 发布门禁修补 | annotated tag 的 `git cat-file` 判定 |
| 2026-11-16 | 3 | L 字段级检索 | 参考文献索引、归一化统一、返回全部命中 |

**版本号不是线性的**：`v0.1.3`→`v0.1.112` 共 110 个 release bump，几乎每个功能提交后紧跟一个版本提交。这说明仓库把"一次逻辑改动 = 一个 commit，版本 bump = 另一个 commit"当成了纪律（`README.md:352-354`），功能提交的信息因此非常适合当演化证据读。

---

## 2. 阶段详解

### 阶段 A｜2026-10-30 奠基（55 提交）

初始提交 `25fb08b` 就是 **10016 行、27 个文件** 的完整可运行应用：

```
electron/main/index.ts         337   ← 入口 + 同步 + 四十多个 IPC + 窗口，全在一起
src/App.tsx                    350   ← 全部状态与 JSX
src/styles.css                 303   ← 全部样式
shared/types.ts                 73   ← 领域模型（当时只有 73 行）
```

`git show 25fb08b:electron/main/index.ts | head -60` 可以看到 `sync()`、`status()`、`ensureClient()` 与 `BrowserWindow` 同处一个文件。当天后续 54 个提交全部是**在单体里加功能**：文件夹树、回收站、标注同步、PDF 下载、导入导出、增量同步、全文检索、篇内查找、虚拟滚动……到 `v0.1.11` 时 `index.ts` 已膨胀到 5602 行。

### 阶段 B｜2026-10-31 索引韧性（58 提交）

关键词全在提交信息里：`32d661a` *"Make building the full-text index survivable"*、`0dd0934` *"Make an index that was interrupted still answer questions"*、`4b47bfc` *"Say why an index from an older version has to be built again"*、`d98f2a9` *"Lower-case the text before it is measured, not after"*。这一阶段奠定了后面 `fulltext.ts` 的 `bytes` 锚点、`format`/`budget` 两种作废原因与 `skipped` 字段——**是缺陷驱动的基础层能力，不是预先设计**。

### 阶段 C｜2026-11-01 自审与量化（43 提交）

`d58d7ce` *"Audit the index itself, not just the rows it produces"* 把验证对象从"搜索结果"换成"索引文件本身"；`70dfa5b` *"take the cost of a keystroke off the main thread"* 引入 `npm run perf` 的测量纪律；`6abd924` *"Run one copy however many times the icon is clicked"* 是单实例锁的起点（后来抽成 `instance.ts` 的纯函数 `wantsSingleInstance`）。

### 阶段 D｜2026-11-02 决定性拆包（53 提交，本报告重点，见第 3 节）

### 阶段 E｜2026-11-03 状态新鲜度（23 提交）

`426f06e` *"Stop a sync from writing back the config it read when it started"*、`1ad07a9` *"Ask the app what it has rather than what it had a moment ago"*。这是「磁盘事实是唯一真相」这条基本事实第一次被明确编码：同步结束时 `saveConfig({ ...loadConfig(), lastSync })` 重新读盘，而不是复用函数开头的 `cfg`（`electron/main/library.ts:116`）。

### 阶段 F→G｜2026-11-04~06 共享规则运动（52 提交）

`ab086b5` *"Share one page-budget rule across the IPC boundary"*、`14c7f13` *"Share one plain clamp across six call sites"*、`3178d14` *"Share one bitmap pixel-size rule across four call sites"*、`1ef32ea` *"Share one line-stitching merge between find and selection"*、`a24279a` *"Name the eight product-side delays"*、`e024a9b` *"Give every swallowed failure a named reason"*。三天里 `shared/` 从 1 个文件长到 16 个。**领域需求反向驱动基础层**最密集的一段，详见第 4 节。

### 阶段 H→I｜2026-11-07~08 正确性与信任边界（26 提交）

`2d4757c` 新增 `shared/libraryReconcile.ts`（三方裁决），`f073acd` 新增 `shared/filePages.ts`（marker 是文件 id），`d75596a`+`02aa9b6` 把第五轮评审的 15 项缺陷记成 backlog 再一次性修完。`e419fda` 是一次提交里同时做四件事的分水岭：

```
e419fda  Harden IPC boundaries and add a unit-test foundation
  shared/pathPolicy.ts          174 +++   ← 全部不可信输入校验集中
  src/window.d.ts                20 +++   ← Window ambient 与 Api 契约分离
  src/lib/configWrite.ts         32 +++   ← 配置写入单一入口
  tests/renderer-pure.test.ts  2032 +++   ← 纯 Node 单测地基
  tests/security.test.ts        240 +++
  tests/shared.test.ts         1289 +++
  vitest.config.ts               17 +++
```

提交信息里那句 *"Context isolation isolates code, it does not validate payloads"* 是整阶段 I 的论点；它还顺手解决了"两个手写 `Api` 已漂移"（`openExternal: void` vs Promise）和"每次生产启动都打包整个 smoke 套件"（改为动态 `import('./smoke')` 独立 chunk）。

### 阶段 J→L｜2026-11-09~16 可验证性收尾（12 提交）

`8736d7e` 把 `smoke.ts` 抽出 7 个 `smoke-*.ts` 纯断言块、把 `styles.css` 逐字切成 12 个有序分片；`dd0ec75` 给主进程 IPC handler 补行为测试；`1fd4437` 把浮层优先级抽成 `topOverlay` 纯规则 + 单测；`ba932c0` 统一归一化并让 `refsindex.ts` 存 `hay` 归一化副本。

---

## 3. 决定性重构深挖

### 3.1 `af4f4c3` — 单体入口拆成六域 + `smoke` 独立文件

`git show --stat af4f4c3`：

```
electron/main/index.ts       | 5602 +-----------------------------------------   ← 删掉 5585 行
electron/main/ipc/{docs,files,index,library,marks,system}.ts |  604 ++++
electron/main/smoke.ts       | 4383 +++++++++++++++++++++++++++++++++++++
electron/main/{demo,ftops,instance,library,perf,window}.ts  |  762 ++++
19 files changed, 5860 insertions(+), 5585 deletions(-)
```

**文件迁移对照表**（旧路径 → 新路径 → 职责变化）：

| 旧位置（`index.ts` 内） | 新位置 | 职责变化 |
| --- | --- | --- |
| 四十多个扁平 `ipcMain.handle` | `ipc/{library,system,docs,marks,files}.ts` | 按「属于哪个域」分组，新增通道不再问"插在列表哪里" |
| `sync()` / `ensureClient()` / `attachPdfs` | `library.ts` + `pdfindex.ts` | 同步编排从启动逻辑里剥离 |
| 窗口创建 / bounds 记忆 | `window.ts` | 只管窗口 |
| 单实例锁 / 第二次点击 | `instance.ts` | 抽出纯函数 `wantsSingleInstance(argv)`，可测 |
| `protocol.handle` / 启动分支 | 留在 `index.ts` | 入口只剩 142 行，头注释改写成 *"The entry point, and nothing else."* |
| 混在入口末尾的 4383 行冒烟 | `smoke.ts` | 独立文件，后由 `e419fda` 改成动态 import 独立 chunk |
| 全文索引的启动/驱动 | `ftops.ts` | `initFt()` 必须在 `registerIpc()` 之前 |

**三条分层本质**：
1. **语义下移**：同步、索引、窗口这些"应用做什么"离开入口，入口只回答"这次是哪一种启动"。
2. **顺序显式化**：`ipc/index.ts:8-20` 的注释把 `initFt()` 必须先于 `registerIpc()` 写成文字，而不是靠代码位置的偶然。
3. **注册从改代码变成改归属**：新增通道是"放进哪个 `ipc/*.ts`"的问题，聚合器 `registerIpc()` 只手工调六个函数（`ipc/index.ts:22-29`）。

### 3.2 `f864926` — 八个布尔标志 → 一个 `View` 联合类型（范式切换）

`git show --stat f864926`：`src/App.tsx` 106 行改写、新增 `src/lib/view.ts` 40 行。新增文件的注释把动机说得比任何总结都清楚：

```ts
// src/lib/view.ts（f864926 版本）
/**
 * The middle of the window used to be decided by a chain of eight
 * ternaries — `adding ? … : importing ? … : ftMode ? …` — each one a
 * separate piece of state that happened to be non-null. That is modes
 * piled on top of each other, not a view: nothing says what is on screen
 * now, only what was turned on last ...
 *
 * So it is one value with one meaning, and the payload each screen needs
 * travels with it instead of living beside it. A screen that is not
 * showing is not merely hidden, it does not exist: its entries, its
 * duplicate groups and its list of deleted papers are all gone with it,
 * which is what stops a stale copy of them from being drawn later.
 */
export type View =
  | { kind: 'library' } | { kind: 'fulltext' }
  | { kind: 'import'; entries: Entry[] } | { kind: 'add' }
  | { kind: 'dupes'; groups: DupeGroup[] }
  | { kind: 'trash'; docs: Doc[] }
  | { kind: 'annotations'; anns: Annotation[] }
```

这是**从「状态 = 若干独立标志」到「状态 = 一个带 payload 的代数数据类型」的范式切换**：payload 随视图走，视图不显示时它的数据就不存在，从类型层面消除了 stale 副本。`HEAD` 里这条线继续演化：`c0d575c` 加了 `{ kind:'reader' }`，`src/lib/view.ts:64-66` 的 `viewAfterReadingToggle` 取代了又一处三元链，`ba89d99` *"Give reading a view of its own instead of a column"* 是同一范式的延伸。

### 3.3 `e419fda` — 从「唯一回归是冒烟」到「纯规则 + 单测 + 门禁」

| 维度 | 演化前 | 演化后 |
| --- | --- | --- |
| 规则位置 | 散在 `ipc/system.ts` 各 handler 内联 | `shared/pathPolicy.ts` 四个可注入平台的纯函数 |
| 契约 | `src/global.d.ts` 一份 + preload `export type Api = typeof api` 一份（已漂移） | 唯一 `Api`，preload `const api: Api = {...}` 编译期双向校验 |
| 回归 | 12k 行 `smoke.ts`，要真实窗口和真实库 | 新增 3561 行纯 Node Vitest；CI / release 两道门禁 |
| 配置写入 | 二十多处 `setConfig` 无 rejection 分支 | `src/lib/configWrite.ts` 统一入口 + reporter |
| 打包 | 每次生产启动都内联整个 smoke | `await import('./smoke')` 独立 chunk |

`git show e419fda -- electron/preload/index.ts` 里两行 diff 尤其说明问题：

```diff
-  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
+  openExternal: (url: string) =>
+    ipcRenderer.invoke('shell:openExternal', url) as Promise<{ ok: boolean; error?: string }>,
...
-export type Api = typeof api
+export type { Api }
```

以及 `src/global.d.ts` 删除了 `declare global { interface Window … }` 与 `declare module '*.svg'`——它们迁到 `src/window.d.ts`，理由是主进程 TS 工程没有 DOM（`src/window.d.ts:3-7`）。

### 3.4 `8736d7e` — 有序拆分而不是按主题重排

`git show --stat 8736d7e`：`styles.css` 从 1919 行变成 12 行 `@import`，12 个分片"逐字切出、规则顺序不可重排"（`HANDOFF.md:693-694` 要求改动时先按顺序拼接与 `HEAD` 逐字节比对）。`smoke.ts` 只抽走 6 个"不碰窗口、不碰真实库、不读自身源码"的纯断言块，且要求新模块**只能用静态 import、必须与 `smoke.ts` 同级**——因为 `electron.vite.config.ts` 的 `chunkFileNames` 让主进程用 `__dirname` 定位 preload / renderer / 仓库根，chunk 多一层目录会让这些路径全失效。这是一条**由构建布局反向约束源码结构**的证据。

---

## 4. 领域需求反向驱动基础层（逐条 diff 证据）

这是"基础层如何被炼成"的关键信号：**新能力不是先设计好再等调用，而是领域里踩了坑之后被下沉进 `shared/`，并同时开放扩展点**。

### 4.1 `ab086b5` 页数预算下沉（最典型）

提交信息原文：*"The full-text page budget was clamped twice: once in the renderer write path and once in the index builder, with the default 3 copied into three places while the main process never imported `DEFAULT_FT_PAGES` … Changing the default meant editing three files."*

diff 显示两边同时被替换：

```diff
// electron/main/fulltext.ts
-let pages = 3
+let pages = DEFAULT_FT_PAGES
+import { clampFullTextPages } from '../../shared/fullTextPages'
-  const next = Math.max(1, Math.min(50, Math.floor(Number(n)) || 3))
+  const next = clampFullTextPages(n)

// src/App.tsx
-  const next = Math.max(1, Math.min(50, Math.floor(n) || DEFAULT_FT_PAGES))
+  const next = clampFullTextPages(n)
```

新增 `shared/fullTextPages.ts` 把边界（`1`/`50`）、默认值（import 自 `types.ts` 而非抄 `3`）、夹取规则收在一处，并**用 190 个输入的差分断言 + 一条"旧的两条规则确实会不一致"的对照**，证明迁移没有偷偷改变任何答案。后续 `f6fdac6` *"Clamp restored page budgets through the shared rule"* 和 `92b194b` *"Write the effective page budget back into the settings field"* 继续把第三个、第四个调用点接进来——**一份规则被逐步"吸"走所有调用点**。

### 4.2 `f073acd` 云端分页坑 → `shared/filePages.ts`

提交新增 `shared/filePages.ts`，头注释记录了一次真实故障：

```ts
// shared/filePages.ts:4-10
 * The API pages this endpoint with `marker`, and the marker is the **file's
 * own `id`**, not `document_id`. Passing `document_id` makes the server
 * answer with the first page again: the old loop kept asking for 200 more
 * rows, added the same 200 ids to a set, and eventually gave up — so a
 * library with 5399 attachments looked like it had exactly 200.
```

修复不是"在 `mendeley.ts` 改一个字段"，而是把分页机制留在通用 `shared/paged.ts`（`newIds === 0` 即停、marker 不前进即停），把"mark 是文件 id、但我们要的是 `document_id`"这段领域语义放进 `shared/filePages.ts` 的 `observe` 包装。基础层由此获得了一个 `fetchPage` 注入插槽，领域层得到可测的语义。

### 4.3 `2d4757c` 回收站竞态 → `shared/libraryReconcile.ts`

新增文件的头注释把事故写成了设计文档：*"A pull can run for minutes. While it is talking to Mendeley the reader may trash a paper, import a PDF, or edit a field … The old sync wrote the snapshot it had taken at the start straight back to disk, so a paper trashed during a pull came back, and because an incremental merge keeps everything already in the cache, it then stayed there until a full pull."*

结果是一个**不碰磁盘/网络/Electron/React** 的纯函数 `reconcileSyncWrite({started, proposed, current, trashedIds})`（`shared/libraryReconcile.ts:31-75`），领域层 `electron/main/library.ts:103-109` 只负责在写盘前重读 `current`。`587e439` 之后又补了字段级三方合并（`:50-57`），把「整行裁决」升级为「字段裁决」。

### 4.4 `ba932c0` 归一化契约统一（最近一次）

`git show ba932c0 -- src/lib/searchScope.ts`：

```diff
-  return q.trim().toLowerCase()
+  return q.trim().toLowerCase().replace(/\s+/g, ' ')
```

同一提交让 `refsindex.ts` 存 `hay` 归一化副本、让 `savedSearch.ts` 改用共享规则、让 `searchRefs` 遍历全部命中（每篇上限 8、全局 200）。`HANDOFF.md:616-621` 同步把契约从「`all` 与内联 `hay()` 逐字节一致」改写成「等于旧 `hay()` 再折叠空白」，并注明这是**有意放宽**：*「输入带两个空格时旧书目表搜不到、参考文献却能搜到」*。这是"领域里两个视图给出不同答案 → 基础层多出一条规则 → 文档同步改写契约"的完整闭环。

### 4.5 `587e439` 与 `e024a9b` 两个"批量下沉"提交

`587e439` *"Harden correctness and collapse duplicated rules"* 一次新增 `src/lib/updateText.ts`（两处更新文案归一）、`src/lib/hooks/useLazyPdfPages.ts`（两处页面抓取归一）、`tests/refactor-regression.test.ts`（差分回归）；`e024a9b` *"Give every swallowed failure a named reason"* 新增 `shared/failures.ts` 的 `FAILURE` 常量表与 `ignoreFailure`/`reportFailure` 两道门。**后者的关键设计**：`FailureReason` 是字面量联合类型，任何调用点想"顺手发明"一个新的静默失败都会编译失败——基础层用类型系统防止自己被绕过。

---

## 5. 演化规律总结

### 5.1 维度对比表（演化前 vs 演化后）

| # | 维度 | 演化前（2026-10-30） | 演化后（2026-11-16） | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 入口职责 | `index.ts` 5602 行：启动 + 同步 + 40 个 IPC + 冒烟 | `index.ts` 142 行，六个域注册器 + 独立 `smoke.ts` | `af4f4c3`、`HEAD:index.ts` |
| 2 | 视图表示 | 8 个布尔标志 + 三元链，payload 与标志并列 | 单一 `View` 联合类型，payload 随视图走，不显示即不存在 | `f864926`、`src/lib/view.ts` |
| 3 | 跨进程契约 | 两份手写 `Api`，已漂移（`openExternal: void`） | 唯一 `src/global.d.ts`，preload `const api: Api` 编译期校验，`window.d.ts` 单独放 DOM ambient | `e419fda` |
| 4 | 规则位置 | 夹取/页数/UA/归一化在调用点手抄 2~5 份 | `shared/` 16 个纯规则模块，一份规则被所有调用点 import | `ab086b5`、`14c7f13`、`ba932c0` |
| 5 | 信任边界 | `mendeley://pdf` 可取任意本地文件、`export:leave` 可越界、`config:set` 合并任意键 | 全部输入经 `shared/pathPolicy.ts`；`satisfies Record<keyof AppConfig, true>` 让漏审配置成为编译错误 | `e419fda`、`shared/pathPolicy.ts:109-174` |
| 6 | 回归手段 | 12k 行真实窗口冒烟（唯一），不能进 CI | 519 个纯 Node Vitest 用例 + 14 个测试文件 + CI/release 两道门禁；冒烟仍保留但只本地跑 | `vitest.config.ts`、`.github/workflows/ci.yml` |
| 7 | 并发正确性 | 并行同步互踩水印；同步在途本地编辑被覆盖；`/files` 分页死循环 | `syncQueue` 串行化、`reconcileSyncWrite` 四快照裁决、`paged.ts` 双终止条件 | `shared/syncQueue.ts`、`libraryReconcile.ts`、`paged.ts` |
| 8 | 失败语义 | 无名字的空 `catch` 散落各处 | `FAILURE` 字面量联合 + `ignoreFailure`/`reportFailure` + sink 审计 | `e024a9b`、`shared/failures.ts` |
| 9 | 新增领域成本 | 往 `index.ts` 列表末尾插一个 `ipcMain.handle` | 判断属于哪个 `ipc/*.ts`；若涉及新配置键，编译期强制先决定是否可写 | `ipc/index.ts:8-20`、`pathPolicy.ts:103-130` |
| 10 | 文档与代码关系 | HANDOFF 是功能清单 | HANDOFF 按主题写「改这些地方之前先读」，记录坑与判据，不写死会变的数字 | `HANDOFF.md:421-670` |

### 5.2 驱动力量

1. **范式觉醒（最高效）**：`f864926` 把"模式堆叠"改成一个带 payload 的联合类型；`e419fda` 把"隔离 = 安全"改写成"隔离只隔离代码，校验要单独做"。这两次不是加功能，是换掉对问题的定义。
2. **领域需求反向驱动基础层（最高频）**：`ab086b5`（默认值三处不一致）、`f073acd`（5399 附件被看成 200）、`2d4757c`（回收站论文复活）、`ba932c0`（双空格查询两个视图答案不同）——每一次都是**具体事故 → 纯规则下沉 → 差分/行为测试锁定 → HANDOFF 补一条约定**。`shared/` 是这么长出来的，不是先画好的。
3. **工具/可验证性驱动**：`e419fda` 引入 Vitest 与 CI 门禁后，后续 8 天的提交模式变成"先补纯规则单测，再改接线"（`1fd4437` 浮层栈、`dd0ec75` handler 行为测试、`ea5686f` 同步与标注接线）——**有了便宜的回归，才敢继续拆**。
4. **文档沉淀后再实现**：`d75596a` 先记录第五轮评审 backlog，`02aa9b6` 再一次性修完 15 项；`84ec2de`/`e8ac7eb` 先写 polish 清单再逐条兑现；`be15f20`/`97fb679` 把 README/HANDOFF 重写到与当前树一致。文档在这个仓库里是**设计载体**而非事后说明。

### 5.3 一条贯穿全史的判据

> **「一份规则」比「一个功能」更值得提交。**

322 个提交里，`Release v0.1.X` 占约 110 个，剩下的绝大多数不是"新增能力"，而是"把已经在两处、三处写过的同一条规则收成一处，并配一条能证明没改变答案的断言"。`HANDOFF.md:300-301` 把方法固化为：*「抽共享规则前把旧表达式逐行抄进测试、对大批量输入逐值比，并单独证明退化差异真实存在。共享常量不等于共享规则，『怎么夹取』也要收进同一模块。」* 这正是本次「优化重构」必须遵守的工作方式。

---

## 6. 结论

这个仓库的 18 天不是"从零写了一个应用"，而是"把一个已经能跑的单体，沿着『磁盘事实可信 / 跨进程输入不可信 / 异步结果需要归属标记』这三条约束，一层层剥成可验证的结构"。三次范式切换各自解决了一类不可靠性：入口拆包解决**职责不可辨**，`View` 联合类型解决**状态不可信**，单测地基解决**改动不可验**。

遗留的演化断点也很清楚，且都被 `HANDOFF.md:682-698` 主动登记：`App.tsx` 剩余状态簇、`smoke.ts` 剩余的 UI 驱动链、`fulltext.ts` 索引状态机仍主要靠源码串断言守护、五份 JSON 无 schema 版本。它们是"下一轮"的起点，而不是遗漏。

> **重构后记（2026-11-16）**：本轮重构继续了 §5.2 描述的「一份规则被逐步吸走所有调用点」模式——把剩余四个检索 UI、启动脚本与两份 workflow 的产物校验接回共享实现，并给抽规则的动作补上逐值差分测试。详见 [优化重构说明](./优化重构说明.md)。

> 配套产物：[架构演化分析 HTML](./mendeley-ng架构演化分析.html) · [架构实现分析](./mendeley-ng架构实现分析.md) · [第一性原理与设计巧思分析](./mendeley-ng第一性原理与设计巧思分析.md) · [优化重构说明](./优化重构说明.md)
