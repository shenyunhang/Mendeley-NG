# Mendeley NG 第一性原理与设计巧思分析报告

> **分析对象**：`D:/mendeley-ng`
> **分析日期**：2026-11-16
> **引用口径**：代码与文档行号为分析时定位
> **结论先行**：根本问题是「一个终将失效的外部服务，要持续喂养一份必须永远可读、可搜、可带走的本地库」；四条基本事实（磁盘是唯一真相、跨进程输入不可信、PDF 文本抽取代价高且转码有损、异步结果属于它出发时的世界）决定了代码形状。

---

## 1. 根本问题与基本事实

### 1.1 根本问题（一句话）

> **一个终将失效的外部服务（Mendeley API / 被冻结的 1.19.8 客户端），要可靠地喂养一份必须永远可读、可搜、可带走的本地文献库。**

`README.md:10-27` 把这条约束说得不含糊：官方客户端停在 1.19.8 且「不会再有新功能开发」，接班人是另一个账号与云端优先的产品；NG 换掉的是**依赖关系**——云端是同步源，不是宿主；API 关掉、token 过期或断网时，屏幕上的库照常能用。同时它也诚实承认「暂时仍要依赖它的 API」。

### 1.2 四条不可再分的基本事实

| # | 层面 | 基本事实 | 它推翻了什么表面答案 |
| --- | --- | --- | --- |
| **A** | 本体论 / 工程论 | **磁盘事实是唯一真相；状态必须能从磁盘重新推导，进程内快照一律不可信。** | 推翻「同步 = 用云端答案覆盖本地缓存」，也推翻「把配置/阅读位置缓存在闭包里省一次读」。外部还有第二个窗口、恢复流程、手改文件，任何缓存都会过期。 |
| **B** | 认知论 / 信任边界 | **跨 IPC 的一切都是输入不是事实；危险集合不是可枚举的清单。** | 推翻「开了 `contextIsolation` 就安全」，也推翻「列出 `file:` / `javascript:` 过滤掉就行」。隔离的是代码，不是载荷。 |
| **C** | 工程论 / 度量 | **PDF 是不可变二进制，但文本抽取代价高且转码有损；offset 必须与它描述的文本在同一份、同一次写里度量。** | 推翻「用文件字节偏移就行」「先 lowercase 再算长度无妨」「抽全库全文做倒排索引」。一个汉字 3 字节但 1 个 code unit；`İ` 小写后变成两个 code unit。 |
| **D** | 认知论 / 时间 | **异步结果属于它出发时的世界；promise 不可取消，作废只能靠「归属标记 + 代次」，不能靠清空 state 或比较值。** | 推翻「`clearTimeout` 就取消了请求」「把 state 清空就等于取消」「值没变就说明答案还有效」。离开 reader 再回来，`View` 值相同但在途答案仍须被拒。 |

**事实验证**：`e419fda` 的提交信息 *"Context isolation isolates code, it does not validate payloads"* 是 B 的原始表述；`HANDOFF.md:266-269` 记 A 的事故（阅读位置缓存导致 `reading:load` 与 `reading:set` 答案不一致）；`electron/main/fulltext.ts:575-577` 记 C 的事故（U+0130）；`src/lib/viewGeneration.ts:23-32` 用 `generation++` 而不是值比较来实现 D。

---

## 2. 从基本事实推导必然设计

| 推导 | 必然出现的机制 | 代码证据 |
| --- | --- | --- |
| A：云端答案只是提议 → 必须有一层裁决 → 写盘前重读磁盘 | `reconcileSyncWrite` 四快照 + `syncQueue` 串行化 + `saveConfig({...loadConfig()})` | `shared/libraryReconcile.ts:24-29`、`electron/main/library.ts:103-116`、`shared/syncQueue.ts:17-23` |
| B：载荷不可信 → 必须白名单而非黑名单 → 新增字段必须被强制审查 | `pathPolicy` 四个函数 + `satisfies Record<keyof AppConfig,true>` + `const api: Api` | `shared/pathPolicy.ts:109-174`、`electron/preload/index.ts:22` |
| C：抽取昂贵 → 必须增量、可中断、可续跑 → 索引必须自描述 | `bytes` 锚点 + `truncate` 与 entry 表同一次 `saveMeta` + mtime/size 增量 + checkpoint | `electron/main/fulltext.ts:515-521`、`refsindex.ts:303-326` |
| D：结果不可取消 → 必须给每个答案贴标签 → 作废只推进代次 | `documentScope` / `latestSearch` / `pdfcache` 三套代次 + `StaleFlight` | `src/lib/documentScope.ts:62-70`、`pdfcache.ts:90-103`、`viewGeneration.ts:23-32` |
| A+C：本地库必须能整体带走 → 每类数据都要有通用格式出口 | 「带走整个库」一次写书目/笔记/标注/PDF + 说明文件 | `src/lib/export.ts:98-110`（注释：笔记是本库唯一无处可去的数据） |

**检验标准**：一个设计若不服务 A/B/C/D 之一，就是装饰。项目里几乎所有"反常"的写法（不用 SQLite 而用五个 JSON、索引不原地覆盖而追加、宁可多读一次盘也不缓存）都能找到归属；而真正属于装饰或债的部分（如 `smoke.ts` 里读自身源码的断言）被 `HANDOFF.md` 主动登记为待拆区间。

---

## 3. 代码巧思全景（14 项，覆盖 5 层）

### 层一：存储 / 持久化层

#### 巧思 1｜四快照三方裁决：云端答案只是「提议」

- 位置：`shared/libraryReconcile.ts:24-29, 50-57, 71-93`；调用点 `electron/main/library.ts:103-109`
- 证据：

```ts
export interface SyncReconcile<T extends { id: string }> {
  started: T[]        // 拉取开始时的缓存
  proposed: T[]       // 拉取算出的答案
  current: T[] | null // 写盘前重读的文件
  trashedIds: Set<string>
}
// 字段级三方合并：本地改过、云端没改的字段归本地
if (!same(ov, bv) && same(tv, bv)) out[key] = ov
```

- 做什么：一次拉取可跑数分钟，期间用户打星标、改文件夹、移入回收站、导入 PDF。裁决保证「在途本地编辑不被覆盖」「已删除的不复活」「本地新增的不被云端答案丢掉」。
- **为什么必然**：服务事实 A。云端是同步源不是宿主，因此它的回答**没有资格**直接写盘；只有把 `current` 也纳入输入，才能让"磁盘事实"在裁决里有一票。`2d4757c` 的事故（回收站论文复活）证明省略这一步会真的丢数据。

#### 巧思 2｜`flag:'wx'` 把「判空」与「占名」合成一次原子操作

- 位置：`shared/uniquePdfPath.ts:42-47`
- 证据：

```ts
for (const candidate of pdfCandidates(dir, wanted)) {
  try {
    fs.writeFileSync(candidate, buf, { flag: 'wx' })
    return candidate
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
```

- 做什么：导入 PDF 时自动取 ` (2).pdf`、` (3).pdf`，不覆盖先到的那篇；只有 `EEXIST` 才试下一个，其它错误交调用方。
- **为什么必然**：服务事实 A（本地 PDF 是不可重建的资产，云端附件可再下载，本地文件被覆盖就真没了）。`existsSync` + `writeFileSync` 两步会让两个并发导入同时通过检查，后者静默覆盖前者——这正是"进程内快照不可信"在文件系统上的版本。

#### 巧思 3｜tmp + rename 原子写，并把例外写进约定

- 位置：`shared/atomicJson.ts:7-11`；例外 `electron/main/store.ts:50-56`、`electron/main/mendeley.ts:477-483`
- 证据：

```ts
export function atomicWriteJson(file: string, value: unknown, space?: number | string) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, space), 'utf-8')
  fs.renameSync(tmp, file)
}
```

- 做什么：进程写到一半被杀只留旧的完整文件。凭据 `token.json` 与 `saveConfig` 是**刻意例外**：前者 `renaming replaces the inode and would discard the file permissions`，后者受 `smoke.ts:11402-11404` 的源码串断言守护。
- **为什么必然**：服务事实 A。原子写是"磁盘事实可信"的最低门槛；而把例外显式登记、并用断言锁住，等于承认"没有一条规则能覆盖全部场景"，同时不让例外变成无人知晓的旁路。

#### 巧思 4｜没有 schema 版本，但用「结构校验失败即视为无缓存」把损坏挡在写入之前

- 位置：`electron/main/store.ts`（五个 JSON）、`HANDOFF.md:701-702`
- 做什么：读到不认识的结构不猜、不修，直接当作没缓存，随后一次完整同步重建。
- **为什么必然**：服务事实 A，代价是对损坏现场零保留。这是**诚实的取舍**（`HANDOFF.md` 主动登记为限制），比"尽力解析半份缓存然后写回一份更错的"更符合"状态不撒谎"。

### 层二：协议与信任边界层

#### 巧思 5｜`satisfies Record<keyof AppConfig, true>` 让"忘了决定"变成编译错误

- 位置：`shared/pathPolicy.ts:103-130, 149-174`
- 证据：

```ts
} satisfies Record<keyof AppConfig, true>
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])
export function safeConfigPatch(raw: unknown): Partial<AppConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN.has(key) || !(key in CONFIG_KEYS)) continue
```

- 做什么：`config:set` 只接受白名单键与类型；未知键、`__proto__` 类键、非有限数值、非法 `theme` 一律丢弃；新增配置字段却没决定是否可写，**是类型错误而不是静默忽略**。
- **为什么必然**：服务事实 B。黑名单永远追不上新危险，白名单 + 编译期穷尽检查把"漏审"从运行时事故前移成构建失败。

#### 巧思 6｜只放行 `http:`/`https:`，并整批拒绝越界路径

- 位置：`shared/pathPolicy.ts:49-56, 62-70, 87-100`；调用点 `ipc/system.ts:116-126, 266-276`、`index.ts:67-74`
- 证据：

```ts
if (p.isAbsolute(rel) || p.parse(rel).root) return null
const joined = p.resolve(root, rel)
return isPathWithin(root, joined, platform) ? joined : null
```

- 做什么：`export:leave` 的每个 `files[].name`、`copies[].to` 先解析到所选目录内，任一越界**整批拒绝**（不是过滤后凑合用）；`../`、绝对路径、盘符相对 `C:foo`、UNC、NUL 全部拒收。`canServePdf` 只服务 `pdfDir` 根内或 `library.json` 已登记附件的精确路径。
- **为什么必然**：服务事实 B，并且平台参数可注入（`platform: Platform = host()`），使 Windows 大小写/反斜杠语义能在任意 runner 上被 `tests/security.test.ts` 的 49 个用例穷举。

#### 巧思 7｜唯一 `Api` 契约 + 显式类型注解，而不是 `satisfies`

- 位置：`src/global.d.ts:26-30`、`electron/preload/index.ts:17-23, 219-223`、`src/window.d.ts:1-14`
- 证据：

```ts
/** `satisfies` would allow extra methods to appear here without the
 *  renderer ever hearing about them, so the annotation is explicit. */
const api: Api = {
  loadLibrary: () => ipcRenderer.invoke('library:load') as Promise<Library | …>,
```

- 做什么：64 个方法全部带 `as Promise<T>` 断言；`contextBridge` 只暴露一个 `api` 对象，`ipcRenderer` 从不外泄；`window.d.ts` 单独放 `declare global`，让无 DOM 的主进程 TS 工程也能安全 import `Api`。
- **为什么必然**：服务事实 B + 事实 A 的"一份规则"推论。历史上两份手写 `Api` 已经漂移过一次（`openExternal: void` vs Promise）；显式注解连"多出一个方法"都拦住，而 `satisfies` 不会。

#### 巧思 8｜具名失败两道门，空 `catch` 无法伪装成决定

- 位置：`shared/failures.ts:24-37, 48-83`
- 证据：

```ts
export function ignoreFailure(reason: FailureReason, _error?: unknown): void {
  tally(reason, 'ignored')
}
export function reportFailure(reason: FailureReason, _error?: unknown): void {
  tally(reason, 'reported')
  if (sink) sink(reason, 'reported')
  else console.warn('[mendeley-ng] ' + reason)
}
```

- 做什么：`ignoreFailure` 用于可选读/清理，`reportFailure` 用于「本地已成功但副作用没落盘」；两者都计数，后者可见，`FailureReason` 是字面量联合类型。
- **为什么必然**：服务事实 A（本地成功、云写失败时不能假装无事发生）+ 事实 B（调用点不能自己发明静默失败）。`sink` 让冒烟能审计"这一轮吞了哪些失败"。

### 层三：索引 / 度量层

#### 巧思 9｜`at` 与 `byteAt` 双锚点，且 `m.bytes` 与 entry 表同一次落盘

- 位置：`electron/main/fulltext.ts:137-148, 506-521, 711-714`
- 证据：

```ts
 * Offsets in the table are counted in UTF-16 code units and the file is
 * measured in bytes, and the two are not convertible without reading the
 * whole thing — one Chinese character is three bytes but one code unit.
const next = { at: anchor.at + g.text.length, byteAt: anchor.byteAt + buf.length }
m.bytes = next.byteAt
```

- 做什么：索引是**追加 + 改指向**，不做原地覆盖；`truncate` 到 `fresh.bytes` 与空 entry 表在同一次 `saveMeta` 落地，回收上次中断留下的"已写未登记"文本。
- **为什么必然**：服务事实 C。若把 code unit 当字节用，`docAt` 的二分查找会把命中归到别人的论文上——索引错了比没有索引更糟（`HANDOFF.md:425`）。

#### 巧思 10｜作废原因分 `format` / `budget`，busy 时用 deferred 而不是立刻替换

- 位置：`electron/main/fulltext.ts:95-106, 303-308, 346-364, 854-857`
- 证据：

```ts
if (busy) { deferred = 'budget'; return true }   // build 会继续写自己那份 detached 表
voided = m.version === 2 && m.pages !== pages ? 'budget' : 'format'
if (busy) {
  for (const d of want) if (!pending.some((p) => p.id === d.id)) pending.push(d)
  return 0
}
```

- 做什么：运行中改页数/清空不能立刻替换模块级 `meta`（否则六分钟跑完却报"从未建过"），改为在 `finally` 里 `applyDeferred()`；并发 build/append 会把两篇写到同一 offset，故用 busy 闸门 + pending 队列排队，两个 `finally` 都 drain。
- **为什么必然**：服务事实 C + D。索引是长任务且不可回滚，任何"立刻生效"的取消语义都会让内存表与磁盘互相说谎；`deferred` 是把"作废"也变成一个**有归属、有时机**的事件。

#### 巧思 11｜mtime+size 增量 + 每 20 篇 checkpoint + 结束时 prune

- 位置：`electron/main/refsindex.ts:269-276, 303-306, 320-333, 351-356, 382-395`
- 证据：

```ts
if (prev && prev.mtime === mtime && prev.size === st.size) { advance(); continue }
if (done % CHECKPOINT_EVERY === 0) save()
const live = new Set(list.map((d) => d.id))
for (const id of Object.keys(c.entries)) if (!live.has(id)) delete c.entries[id]
```

- 做什么：PDF 不变就不重读；无 References 的空结果也缓存；进程被杀仍保留绝大部分工作；已移入回收站/解绑的论文不能继续用旧文本回答搜索。
- **为什么必然**：服务事实 C（抽文本要起 pdf.js worker，代价高）+ 事实 A（索引不能描述一份已经不存在的库）。`prune` 的作用：没有它，`indexed` 会大于 `total`，显示层会"说谎"。

#### 巧思 12｜`RefEntry.hay` 归一化副本：匹配与切片段用同一份文本

- 位置：`electron/main/refsindex.ts:43-50, 75-80, 382-395`
- 证据：

```ts
// Taking the offset from a lower-cased string and cutting the original
// breaks on characters whose lower case is longer (U+0130); folding
// whitespace on the fly would shift every hit after the first one.
const hay = e.hay ?? normaliseQuery(e.text)
let from = 0
while (hits.length < MAX_HITS && perDoc < MAX_HITS_PER_DOC) {
  const at = hay.indexOf(needle, from)
  if (at < 0) break
  hits.push({ docId, page: e.page, snippet: snippetAt(hay, at, needle.length) })
  from = at + Math.max(1, needle.length)   // 单字查询不死循环
```

- 做什么：`hay` 可选，旧缓存没有它时回退到 `normaliseQuery(e.text)`，**不要求重建索引**；`Math.max(1, …)` 防单字查询死循环。
- **为什么必然**：服务事实 C。它同时解决"转码长度变化导致偏移整体错位"和"边折叠边扫描导致第二个命中之后的偏移全错"，并用可选字段实现**向后兼容的 schema 演进**（对照巧思 4 的"无迁移"限制，这里给出了另一种更轻的答案）。

### 层四：异步与展示层

#### 巧思 13｜三套代次 + `StaleFlight`：作废靠编号，不靠清空

- 位置：`src/lib/pdfcache.ts:90-125`、`src/lib/documentScope.ts:39-75`、`src/lib/latestSearch.ts:51-56, 100-121`、`src/lib/viewGeneration.ts:23-32`
- 证据：

```ts
const gen = this.generation
const p = draw().then((c) => {
  if (gen !== this.generation) throw new StaleFlight(key)
  ...
})
// clear() 只递增代次，不试图停掉已发出的 promise
```

- 做什么：`clear()` 停不了在飞的 promise，于是递增 `generation` 让所有等待者走既有失败路径；`documentScope` 给每个值贴 `docId`、给每次读贴代次；`latestSearch` 的 `cancel = supersede` 只推进代次**不写 state**，避免 inactive 面板挂载扰动虚拟表格滚动窗口；`viewGeneration` 用 `generation++` 而非值比较，因为"离开 reader 再回 library"值相同但在途答案仍须被拒。
- **为什么必然**：服务事实 D，且解决了 `HANDOFF.md:601` 那句 *「清 state 停不了已经发出的 promise」*。三处各自实现代次而非抽一个公共类，是因为它们的"归属标签"不同（缓存 key / docId / question），强行统一会丢掉语义。

#### 巧思 14｜`topOverlay` 纯规则 + `runBatch` 只登记成功 id

- 位置：`src/lib/overlayStack.ts:32-39`、`src/lib/hooks/useOverlayStack.ts:29-55`、`src/lib/batch.ts:25-33`、`src/App.tsx:1056-1065`
- 证据：

```ts
export function topOverlay(layers: OverlayLayers): OverlayLayer | null {
  if (layers.settings) return 'settings'
  if (layers.columns) return 'columns'
  if (layers.sort) return 'sort'
  if (layers.filters) return 'filters'
  return null
}
// batch.ts：ok++ 只在 await run() 成功后
try { await run(items[i]!); ok++ } catch { failed.push(name(items[i]!)) }
```

- 做什么：一次 Esc 只关最上面一层（返回 `true` 让调用方在 reader/多选分支前停住）；批量动作没有事务，只把真正成功的 id 登记进 undo，失败名单具名报给用户。
- **为什么必然**：服务事实 A（undo 不能误伤同名记录、按失败名单反推会出错）+ 一条工程推论「可解释性优先」。把浮层优先级做成纯规则，是为了让"新增一张卡片必须决定它插在哪"这件事有单测（`tests/overlay-stack.test.ts` 16 种组合）兜住。

### 层五：工具与验证层（补充）

- `shared/paged.ts:32-46` 的双终止条件（`newIds === 0`、`next === marker`）是**对不可靠外部服务的防御**：服务器忽略 marker 时不会把同一页几千行重复写进 `library.json`，也不会无限请求。服务事实 B 的外部版本。
- `scripts/start.mjs:27-29` 剔除 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`：Electron 系 IDE 终端会把 electron.exe 退化成纯 Node，主进程死在 `app.whenReady()`。服务"运行环境不可信"这一条 A 的延伸。
- `electron/main/smoke.ts:298-303` 的配置快照在**读到配置的那一刻**就写到模块作用域（不是结束时），崩溃路径 `index.ts:103-108` 也会调 `restoreSmokeConfig()`：自检不能动真实数据。服务事实 A。

---

## 4. 巧思 → 基本事实映射表（闭环）

| 巧思 | 层 | A 磁盘真相 | B 输入不可信 | C 抽取有损 | D 异步归属 | 防住/支撑了什么 |
| --- | --- | :---: | :---: | :---: | :---: | --- |
| 1 四快照三方裁决 | 存储 | ● | | | ◐ | 在途编辑被覆盖、回收站论文复活 |
| 2 `flag:'wx'` 占名 | 存储 | ● | | | | 并发导入互相覆盖 PDF |
| 3 tmp+rename 原子写 | 存储 | ● | | | | 写到一半被杀留下半份 JSON |
| 4 结构失败即无缓存 | 存储 | ● | | | | 解析半份缓存再写回更错的 |
| 5 `satisfies` 编译期穷尽 | 协议 | | ● | | | 新增配置字段被静默忽略 |
| 6 白名单 + 整批拒绝 | 协议 | | ● | | | 任意路径读取 / 导出越界 / 危险 scheme |
| 7 唯一 `Api` 契约 | 协议 | ◐ | ● | | | 两份契约漂移、`Promise<any>` |
| 8 具名失败两道门 | 协议 | ● | ● | | | 无声的静默失败 |
| 9 `at`/`byteAt` 双锚点 | 索引 | ◐ | | ● | | 命中被归到别人的论文 |
| 10 deferred 作废 + busy 队列 | 索引 | ◐ | | ● | ● | 长任务被中途取消后半份索引 |
| 11 mtime+size + checkpoint + prune | 索引 | ● | | ● | | 重复抽文本、已删论文仍被搜到 |
| 12 `RefEntry.hay` 归一化副本 | 索引 | ◐ | | ● | | U+0130 偏移错位、多命中偏移全错 |
| 13 三套代次 + `StaleFlight` | 展示 | | | | ● | 旧 PDF 位图/旧词结果盖住新词 |
| 14 `topOverlay` + 只登记成功 id | 展示 | ● | | | ◐ | Esc 一次关两层、undo 误伤 |
| 补：`paged` 双终止 | 工具 | ◐ | ● | | | 服务器忽略 marker 导致死循环 |
| 补：`start.mjs` 剔环境 | 工具 | ● | | | | 主进程在 IDE 终端里静默崩溃 |
| 补：smoke 快照即时写 | 工具 | ● | | | | 自检崩溃后污染真实配置 |

（● 主要服务，◐ 次要服务）

A 与 C 两列主要对应存储层与索引层，B 对应协议层，D 对应展示层。

---

## 5. 代价与边界

1. **约束强度从"不可能错"降级为"错了会被拦住"**。`safeConfigPatch` 能挡未知键，但挡不住一个白名单内的值语义上是错的（`pdfDir` 指向一个不存在的目录）；`reconcileSyncWrite` 能裁决字段，但依赖"写盘前重读"这一次读与写之间不再有第二个写入者——`HANDOFF.md:679-681` 承认原子写不是并发安全的。
2. **通用性换来的性能代价与页数取舍**。`shared/fullTextPages.ts` 默认只索引每篇前 3 页：`electron/main/fulltext.ts:60-64` 记着 5245 篇全页约 293 MB / 前三页约 60 MB 的实测，代价是搜不到时必须说清"读了多少页、这不等于库里没有"，且改页数会丢索引（`README.md:277-281`）。
3. **开放词汇的语义治理成本**。`DOC_TYPES` 白名单之外的值留空显示「（未设）」而不是顶成第一项（`HANDOFF.md:362-363`）；BibTeX 没有独立类型名的网页/专利/程序只能写成 `@misc`，导回会变成 `generic`（`README.md:245`）——这是通用交换格式的固有损失，
4. **可验证性本身有未覆盖区间**。`fulltext.ts` 索引状态机与 `App.tsx` 剩余状态簇仍主要靠 smoke 的源码串断言和真实库自检守着（`HANDOFF.md:695-698`）；`smoke` 因需要真实窗口而无法进 CI，最重的一层回归只能本地跑。
5. **一份规则的纪律有维护成本**。`HANDOFF.md:616-621` 明令"别再让某个范围自己写一遍 `trim().toLowerCase()`"，分析时 `TrashView.tsx:38`、`NotesView.tsx:54`、`FolderTree.tsx:88`、`AddByIdView.tsx:28` 各写一份，`SearchResults.tsx:104` 漏了折叠空白导致"能命中却不高亮"。**规则存在 ≠ 所有调用点都接上了**；这四个调用点与结果卡片已统一到 `normaliseQuery`（改动与验证见 [优化重构说明](./优化重构说明.md)）。

---

## 6. 综合结论

14 项巧思覆盖**表示**（单一 `View` + payload、归一化副本）、**写入**（四快照裁决、原子写、双锚点、checkpoint）、**审计**（具名失败门、索引自审、差分回归）、**解释**（空态说明读了多少页、批量报失败名单、作废分 format/budget）、**演化**（编译期穷尽的白名单、可选 `hay` 兼容旧缓存、纯规则先配单测再改接线）五个维度。

> **因为外部服务不可靠、跨进程输入不可信、PDF 文本昂贵且有损、异步结果不可取消，所以这个系统选择让磁盘做唯一的裁判，让所有规则只留一份且可测，让每一次写入都能被重读与解释，让每一个在途答案都带着它出发时的标签。**

未收敛的部分是**这份纪律还没铺满所有调用点**（第 5 节第 5 条）：漂移的调用点、被空吞的故障、未覆盖的纯逻辑、重复的构建脚本。抽共享规则须遵守 `HANDOFF.md:300-301`「先逐值差分」。

> 相关文档：[第一性原理与设计巧思分析 HTML](./mendeley-ng第一性原理与设计巧思分析.html) · [架构实现分析](./mendeley-ng架构实现分析.md) · [架构演化分析](./mendeley-ng架构演化分析.md) · [优化重构说明](./优化重构说明.md)
