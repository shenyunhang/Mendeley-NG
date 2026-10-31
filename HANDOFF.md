# HANDOFF

给接手的人看的。读完这篇应该能直接跑起来、知道哪里能动、哪里是雷区。

> 注：本文件位于公开仓库，文中刻意不写任何本机路径、库规模或个人身份信息。

---

## 1. 这是什么

**Mendeley NG**，替代 Mendeley Desktop 1.19.8 的桌面文献管理器。
Electron 33 + React 18 + pdf.js 4.10，直接读写用户的 Mendeley 云端库（REST API）。

**为什么重写而不是继续用 1.19.8**：1.19.8 基于 Qt 5.10.1，它向系统声明自己感知 DPI，
但支持不完整——按物理像素渲染、不吃系统缩放倍率，所以在 4K 屏上字只有别的程序一半大。
而改注册表强制 `DPIUNAWARE` 换来的代价是整窗模糊。

Chromium 天然按系统 scale factor 缩放 CSS 像素，**不需要任何 DPI 补丁**。
这是整个项目存在的前提，任何"加个 DPI workaround"的改动方向都是错的——
如果有人报告字体发虚或错位，先怀疑是不是引入了 `zoomFactor` / `--force-device-scale-factor`
之类的东西。

## 2. 当前状态

已跑通并实测：

| 能力 | 状态 |
| --- | --- |
| 云端同步（文献 + 文件夹 + 文件挂载情况） | 可用；默认增量，见第 8 节第 14 条 |
| 本地 PDF 目录扫描与匹配 | 可用 |
| 虚拟滚动列表（数千行不卡） | 可用 |
| 搜索 / 排序 | 可用 |
| PDF 阅读（pdf.js，高 DPI 清晰） | 可用；适宽 / 整页缩放、目录侧栏、连续滚动、相邻页预取 |
| 文本选区高亮（本地持久化 + 云端同步） | 可用 |
| 元数据编辑并 PATCH 回云端 | 可用 |
| 文件夹树（建 / 改名 / 移动 / 删除 / 嵌套） | 可用 |
| 导入 BibTeX / RIS / EndNote XML；导出这三种 | 可用 |
| 按 DOI / arXiv id 添加条目 | 可用 |
| 星标 / 已读 / 标签 | 可用；写回云端 |
| 列定制与保存视图 | 可用；存配置 |
| 撤销栈（删除 / 合并 / 批量改文件夹） | 可用；Ctrl+Z |
| 全文检索（PDF 正文） | 可用；每篇前 3 页，命中带页码与上下文 |
| 批量操作（Shift / Ctrl 多选） | 可用 |
| 自更新（GitHub Releases） | 可用 |
| 界面字号调节 | 可用 |
| Windows 安装包（NSIS） | 可构建；签名管道已通，需自备证书 |

未装证书时 Windows 会弹 SmartScreen，自用点"仍要运行"即可；签名怎么开见 README。
完整的功能缺口见第 7 节的对照表，规划见第 8 节。

## 3. 跑起来

```bash
npm install
npm run build       # 产出 out/
npm start           # 启动（走 scripts/start.mjs，见第 6 节）
npm run dev         # 热重载
npm run typecheck   # main/preload 与 renderer 双侧检查
npm run dist        # 打包 NSIS 安装包
npm run smoke       # 端到端自检，出两张截图
npm run smoke -- --no-sync   # 用本地缓存，跳过同步
```

**首次使用需要 token**，没有内置 client credential，每人都要注册自己的应用。
完整步骤见 README「获取 token」，或直接跑 `node scripts/get-token.mjs <client_id> <client_secret>`。

自检（`--smoke`）会拉库、开隐藏窗口、点第一行有 PDF 的文献、`capturePage` 截图。
日志里打出的 canvas 后备尺寸应是 CSS 尺寸的 `dpr` 倍——**这是验证高 DPI 是否真生效的唯一可靠手段**，
比肉眼看截图靠谱。

## 4. 结构

```
electron/main/mendeley.ts   Mendeley REST 客户端（UA、content-type、401 重试都在这）
electron/main/store.ts      本地缓存：文献 / 文件夹 / 标注 / 配置
electron/main/pdfindex.ts   把 "作者 - 年份 - 标题.pdf" 匹配回云端条目
electron/main/index.ts      主进程、IPC、mendeley:// 协议、--smoke 自检
electron/preload/index.ts   contextBridge，只暴露白名单方法
src/                        renderer
shared/types.ts             main / preload / renderer 三端共享类型
scripts/                    start.mjs 启动器、get-token.mjs、check-api.mjs、hooks/
```

几个约定：

- **类型不要三处各写一份**，改 `shared/types.ts`。
- **所有尺寸用 rem**（`--ui-fs` 为基准），不要写死 px，否则字号旋钮会失效。
- **主进程产物必须是 CJS**：package.json 里不能有 `"type": "module"`。
- `contextIsolation: true`，renderer 拿不到 node，所有能力走 `window.api`。

## 5. Mendeley API 的怪癖（改这块之前必读）

踩过的坑，每条都花了时间：

1. **`GET /documents` 默认 view 不返回 `citation_key` / `file_attached` / `folder_uuids`**，必须带 `?view=all`。
2. **Cloudflare error 1010**：`api.mendeley.com` 拦掉一切不像浏览器的请求，**包括 `/oauth/token`**。所有请求都要带 Chrome UA（`mendeley.ts` 里的 `UA` 常量）。
3. **`POST /folders` 必须用 `application/vnd.mendeley-folder.1+json`**，用默认的 document content-type 直接 415。
4. **`POST /folders/{id}/documents` 的 body 是 `{"id": did}`**，不是 `document_id`。
5. **`DELETE /folders/{id}/documents/{did}`** 成功返回 204；目标已不在该文件夹时返回 **409**；重复调用会 500。
6. **本地库是 SQLCipher 加密的**（文件头不是 `SQLite format 3`），读不了。1.19.8 自己存在库里的凭据同样取不出来——元数据只能走云端 API。
7. **`file_attached` 会撒谎**，所以同步时会额外拉一次 `/files` 交叉核对。
8. **`GET /metadata`（按 DOI / arXiv / PMID 反查元数据）官方文档自己标着 "Coming soon — Not implemented"**。
   想复刻 1.19.8 的 "Update Details" 别指望它，只能走 Crossref / arXiv / `/catalog` 自己兜底。
9. **标注坐标是绝对 PDF 点，而 `top_left` 存的是 y 更小的那个点**，也就是视觉上的**左下角**
   （PDF 用户空间原点在左下）。视觉顶部 = `pageHeight - max(y)`。
   这个命名极具误导性，是拿三条既有云端高亮反查 pdf.js 文本项才敲定的，
   并且在 PDF 标题上做过一次 push/pull 往返验证。改这块前务必重读 `PdfViewer.tsx` 顶部注释。
10. **`POST /annotations` 缺 `filehash` 会被静默降级成普通 note 并丢掉 positions**；
    `filehash + positions + text` → `sticky_note`；`filehash + positions` 且无 `text` → `highlight`。
    所以高亮**绝不能带 text**。`filehash` 就是云端文件字节的 SHA-1，实测与 `/files` 返回的一致；
    但 Mendeley Desktop 下载的本地副本**可能与之不同**，坐标按本地页尺寸换算时要注意。
11. **`GET /files/{id}` 不是返回字节，而是 303 到 S3 预签名地址**。
    那个地址自带签名，不要再带 Authorization 头跟着跳。
12. **`POST /documents` 只接受固定的 type 集合**，实测 `encyclopedia` / `dictionary` / `misc` /
    `standard` / `film_broadcast` / `music_score` / `artistic_work` / `map` /
    `personal_communication` / `legal_rule` / `legal_case` 全部 400（文档里却列着）。
    可用的是 `journal` `conference_proceedings` `book` `book_section` `thesis` `report`
    `generic` `web_page` `working_paper` `patent` `magazine_article` `newspaper_article`
    `computer_program` `statute` `case` `bill` `hearing`。
13. **想不依赖 pdf.js 从 PDF 里抽文本是行不通的**。试过纯 zlib + 正则取 `Tj`/`TJ` 字符串，
    在四篇真实论文上对比 pdf.js 的召回率只有 **0% / 1.8% / 1.9% / 14.2%**：
    subset 嵌入字体的字符串是字形索引而不是 Unicode，抽出来的是字体表和数字。
    全文检索只能用 pdf.js（渲染层里有），代价是要建一个几十 MB 的索引，
    索引哪些页、要不要落盘，是做之前要拍的决定。
14. **文献自带 `tags` / `starred` / `read` 字段且可写**，标签、星级、已读不用另找地方存。
    **`POST /notes` 与 `GET /notes` 都是 404（"No service found"）**，所以文献级笔记
    只能落本地，UI 上要写清楚它不会同步。
15. **`GET /catalog?doi=` 可用，`?arxiv=` 不可靠**：实测 `arxiv=1706.03762`
    返回的是一篇无关的海报。arXiv id 一律走 `export.arxiv.org`。
16. **`GET /documents?modified_since=` 可用**，增量同步有戏；
    但 **`/deleted_documents` 是 404**，删了什么只能靠全量对账发现。
17. **`GET /catalog` 拒绝匿名请求**：401 `"No auth header"`。它不像 `/documents`
    那样可以不要 token，所以按 DOI 添加条目时必须先把 bearer 传进去
    （`Mendeley.bearer()`），没有 token 时整个链路降级到 Crossref 而不是失败。
18. **`/catalog` 只有 `?doi=` 可信**：`?isbn=9780262510875` 返回的是
    "UNIVERSITY OF THE WEST INDIES Department…"，`?pmid=12345678` 返回
    "Denpasar Declaration…"，都是无关记录。ISBN / PMID 一概不走这条路。
19. **`/catalog` 会把标题改成句首大写**：`Deep Residual Learning` 出来是
    `Deep residual learning`。所以 DOI 解析是 Crossref 与 catalog 并行取、再合并，
    重叠字段以 Crossref 为准（它保留出版方存的原样），catalog 只贡献 type
    和它多出来的标识符。
20. **`identifiers` 只保留认得的键**：catalog 还会给 `pui` / `sgr` / `scopus`，
    写进 `POST /documents` 的 body 未必被接受，所以统一过滤成
    `doi` / `arxiv` / `pmid` / `isbn` / `issn`。
21. **`GET /documents?sort=created&order=desc` 可用**，想看最近新增不必全量排一遍。
22. **pdf.js 不允许同一个 canvas 并发渲染**：缩放变化触发第二次 render 时直接抛
    "Cannot use the same canvas during multiple render() operations"。
    必须 `cancel()` 上一个 RenderTask 并吞掉它的 `RenderingCancelledException`，
    否则每次改窗口大小右侧阅读器都会挂掉。
24. **`window.prompt()` 在 Electron 里会抛异常**：`Error: prompt() is not supported.`
    但它**存在**（`typeof` 返回 `function`），所以只有用户真的点那个按钮时才炸，
    静态检查完全看不出来。`window.confirm` 是正常的，可以照用。
    需要输入的地方一律走应用内弹窗（`src/components/AskDialog.tsx`）。25. **预取的离屏渲染排在可见页后面**：pdf.js 的 worker 按提交顺序处理，所以给
    相邻页开的 warm 会晚于当前页完成——实测 dpr 2 下一页要 1 秒以上，等用户翻过去
    时它还在飞。于是翻页又从头渲染一遍，预取等于白做。做法是**加入正在飞的 warm**
    （`Map<key, Promise<canvas>>`）而不是重开一次；缓存也别在缩放变化时整表清空，
    按 `页:缩放:dpr` 做 key + LRU 淘汰即可，否则正好在翻页前把邻居扔掉。
26. **连续滚动里"适配宽度"不能跟着当前页变**：列里每一页都有自己的尺寸，按顶部那一页
    算缩放，滚动时缩放就会变，变了要重排整列，重排又改变滚动位置 → 死循环。
    改成取**最宽的那一页**算，整列共用一个稳定的缩放。
28. **主进程里用 pdf.js 必须自带 worker**。pdf.js 用运行期 import() 加载 worker，
    解析基准是发起导入的模块，打包后就是 `out/main/pdf.worker.mjs`。该文件不存在时
    **每一篇** PDF 都失败，报 Setting up fake worker failed，看起来像全库损坏，
    其实是缺一个文件。`scripts/copy-worker.mjs` 在 build 后复制它。

27. **`electron-builder` 没有证书时会静默跳过签名**：安装包照常编出来、照常能跑，
    和签过名的一模一样看不出区别。所以 CI 不能只看"构建成功"，得用
    `npm run signcheck`（`Get-AuthenticodeSignature`）问 Windows 拿真实状态。

23. **`tags` 清空后字段会消失**：PATCH `tags: []` 回来的响应里没有 `tags`
    （不是空数组）。所以详情面板的标签输入框要用"规范化后再比"判断是否改过，
    否则清空一次就会永远显示成脏的。

## 6. 环境与打包的坑

- **`ELECTRON_RUN_AS_NODE`**：某些 shell（Electron 系 IDE 的终端）会导出它，
  带着它启动 electron.exe 会退化成纯 Node，`require('electron')` 返回二进制路径字符串，
  主进程死在 `app.whenReady()` 报 "Cannot read properties of undefined"。
  所以有个 `scripts/start.mjs` 剔除该变量后再 spawn——**不要改回直接 `electron .`**。
- **`app.quit()` 不接受参数**，带退出码用 `app.exit(code)`。
- **electron-builder 写 exe 版本资源时（rcedit）在本机会报 "Unable to commit changes"**，
  用 `build.win.signAndEditExecutable: false` 绕过。只丢版本信息，不影响功能。
- **打包默认会把 node_modules 塞进 asar**（含 pdfjs 拉来的 `@napi-rs/canvas`，几十 MB）。
  `files` 已收紧为 `["out/**/*","package.json","assets/icon.png","!node_modules/**"]`。
  如果以后主进程真的需要运行时依赖，记得把它加回去，否则 packaged build 会炸。
- **图标由 `npm run icon` 生成，产物直接进版本库**：`assets/logo.svg`（矢量源）、
  `build/icon.ico`（exe / 任务栏 / 安装包）、`build/icon.png`（512）、
  `assets/icon.png`（256，窗口自己用）。
  **改图标要改 `scripts/make-icon.mjs` 里的形状表**，不要手改 svg——两者是同一份定义
  生成的，手改会在下次跑脚本时被覆盖。
  光栅化是脚本自己做的 4 倍超采样 + 面积平均：**不要改成用 Electron 渲染 SVG**，
  那需要一个窗口，而这个环境里带窗口的 Electron 进程会被直接杀掉。
  另外 `build/` 是 electron-builder 默认的 buildResources 目录，**不会被打进 app**，
  所以窗口图标用的是 `assets/icon.png` 那份副本。
  **已知的代价**：改 exe 资源要靠 rcedit，而它在本机必失败（`signAndEditExecutable: false`
  就是为了绕开它），所以 **exe 文件本身在资源管理器里仍是 Electron 默认图标**；
  窗口 / 任务栏 / 安装包 / 开始菜单快捷方式用的都是我们的图标。
  哪天 rcedit 能用（或换 CI 环境）再把这个开关打开。

## 7. 功能对照：1.19.8 有什么，NG 现在有什么

先对齐事实。1.19.8 是 Desktop 的最后一版，它的 release notes 明确写了**主动移除**了一批
社交/发现类功能（Related Documents、Literature Search、建组入口、邀请同事、外部主页链接），
所以"忠实复刻 1.19.8"不包括这些——别把它们当成缺失项补回来。

| 功能 | 1.19.8 | NG 现状 | 缺口 |
| --- | :-: | :-: | --- |
| 文献列表 / 详情 / 元数据编辑 | ✅ | ✅ | PATCH 已回写云端 |
| 文件夹：新建 / 加入 / 移出 | ✅ | ✅ | — |
| 文件夹：重命名 / 移动 / 删除 / 嵌套 | ✅ | ✅ | `PATCH` / `DELETE /folders/{id}`、`parent_id` |
| 云端同步 | ✅ | ⚠️ | 每次全量；缺增量 |
| PDF 阅读 | ✅ | ✅ | 单页渲染，无连续滚动 |
| PDF 高亮标注 | ✅ | ✅ | 文本选区高亮，可删除 / 改色 / 加笔记 |
| 标注同步到云端 | ✅ | ✅ | 坐标须按 PDF 点换算，见第 6 节 |
| 云端 PDF 下载到本地 | ✅ | ✅ | `GET /files/{id}` 是 303 到 S3 预签名地址 |
| 导入文献（拖 PDF / BibTeX / RIS / EndNote） | ✅ | ✅ | 拖 PDF、BibTeX、RIS、EndNote XML |
| Update Details（补全元数据） | ✅ | ✅ | `/metadata` 未实现，走 Crossref + arXiv，见第 5 节 |
| 查重与合并 | ✅ | ✅ | 合并只补齐缺失字段，落败者进回收站 |
| 回收站 / 删除 / 恢复 | ✅ | ✅ | `DELETE /trash/{id}` 才是彻底删除 |
| 导出 BibTeX / RIS | ✅ | ✅ | 缺 EndNote XML |
| 库内检索（`/search/documents`） | ✅ | ⚠️ | 现在是本地过滤，没走 API，也没做高阶筛选 |
| 全文检索（搜 PDF 正文） | ✅ | ❌ | 必须走 pdf.js，见第 5 节第 13 条 |
| 标签（tags） | ✅ | ❌ | API 的 `tags` 字段可读写，库里目前一条都没有 |
| 星级 / 已读 | ✅ | ❌ | 文献自带 `starred` / `read` 字段，直接可写 |
| 文献级笔记 | ✅ | ❌ | **`/notes` 端点不存在（404）**，只能存本地 |
| Word / LibreOffice 引用插件 | ✅ | ❌ | CSL + 插件体系，量级不同，见第 9 节 |
| 引用样式格式化（复制格式化引文） | ✅ | ❌ | 需引入 citeproc |
| 分组协作（Groups） | ⚠️ | ❌ | 1.19.8 已移除建组入口；API `/groups` 标 deprecated |
| 相关文献 / 站内文献检索 | ❌ | ❌ | 1.19.8 已移除，不做 |

## 8. 路线图

### P0 — 补齐读写闭环（API 已支持，风险低，收益直接）

1. **文件夹重命名 / 移动 / 删除 + 嵌套层级**　✅ 已完成
   `PATCH /folders/{id}`（改名或换 parent）、`DELETE /folders/{id}`。
   目前只能建和加，UI 里树是平的，1.19.8 支持子文件夹。
2. **删除与回收站**　✅ 已完成
   `POST /documents/{id}/trash`、`GET /trash`、恢复。
   没有删除入口意味着库里的垃圾只能去网页端清，这是日常最痛的缺口。
3. **标注同步到云端**　✅ 已完成
   `/annotations` 的 GET / POST / PATCH / DELETE 齐全。
   顺带把本地缺失的**删除、编辑、笔记**一起补了——现在只能加不能删。
   注意云端与本地的冲突策略要想清楚（以 `created` 时间戳还是以云端为准）。
4. **云端 PDF 下载**　✅ 已完成
   `GET /files/{id}` 拉到本地缓存目录。
   目前约一成的条目云端有文件但本地没有，这些现在完全读不了。

### P1 — 日常真正会用到

5. **导入：拖 PDF 进库**　✅ 已完成
   `POST /documents` 建条目，`POST /documents/{id}/files` 传文件。
   PDF 内嵌 DOI / arXiv ID 可以先抽出来查元数据，避免建成空条目。
6. **元数据补全（对标 Update Details）**　✅ 已完成
   Crossref + arXiv 查，查不到再退到 `/catalog` 搜。
   这块在旧项目里踩过大坑：**标题模糊匹配阈值 0.72 完全不可信**
   （"Object detection" vs "Lifelong Object Detection" 相似度 0.78，全是错配），
   必须提到 **0.90** 且短标题要关掉子串包含判断。宁可查不到也不要写错。
7. **查重与合并**　✅ 已完成
   本地按 DOI / 标题+年份 / filehash 分组给出候选集，
   人工逐字段确认后合并（保留一条 → 迁移文件夹 → 其余入回收站）。
   1.19.8 的合并是有字段级冲突预览和 Undo 的，值得照做。
8. **导入 BibTeX / RIS / EndNote XML**　✅ 已完成
   现在只有导出，没有导入，换库或迁移时会卡住。
9. **全文检索**　✅ 已完成：只索引每篇前 3 页，文本落一个平文件 + 偏移表，
   不用倒排索引（60 MB 直接 indexOf 扫只要几十毫秒，倒排表比原文还大）。
   增量：文件 mtime+size 没变就跳过。删掉的文献留下的空洞只有「重建」能回收。
   建索引是并发的（最多 4 条车道，且不超过核数-1）、可随时「停止」、
   每篇有 20 秒上限、进度条显示当前在读的文件名。
   **坑**：主进程里跑 pdf.js 需要把 `pdf.worker.mjs` 复制到 `out/main/`，
   否则每一篇都报 Setting up fake worker failed（见第 5 节第 28 条）。
   **坑**：偏移一律按 **UTF-16 code unit** 计，不能拿 `fs.statSync().size`
   当偏移——一个汉字 3 字节但 1 个 code unit，第一个非 ASCII 文档之后
   全部偏移都会偏短，命中会指到别的篇上。
   **坑**：每篇要有超时。pdf.js 碰到坏文件（xref 断了、流不结束）会无限跑，
   串行队列里只要有一篇这样，整条队列就永远停住——这正是「创建索引会卡死」
   的真正原因。超时里必须 `doc.destroy()`，光 resolve 掉 race 只是放弃
   promise，worker 线程还在烧 CPU。
10. **PDF 文本选区高亮**　✅ 已完成
    替换现在的矩形拖框，接 text layer 拿真实选区，顺带能复制文本。

### P2 — 打磨

11. **连续滚动 + 相邻页预取**　✅ 已完成
12. **标签、笔记、星级 / 已读状态**　✅ 标签 / 星级 / 已读已完成（笔记拆到第 25 条）
13. **多选与批量操作**（批量改文件夹、批量删）　✅ 已完成
14. **增量同步**　✅ 已完成：只用 `GET /documents?modified_since=`。
    **`/deleted_documents` 是 404**，删除没有增量通道，只能靠「全量」按钮，
    UI 里也写明了这一点。实测无改动时 3 秒，一小时前的增量 93 秒。
15. **列定制与保存视图**　✅ 已完成
16. **撤销栈**　✅ 已完成：删除、合并、批量改文件夹，Ctrl+Z
17. **安装包签名**　⚠️ 管道已通（CI 读 `CSC_LINK` / `CSC_KEY_PASSWORD`，
    `npm run signcheck` 会校验），**但证书要自己买**，装上才真正消除
    SmartScreen。电子签名证书是个人开支，仓库里没有。
18. **深浅色切换**　✅ 已完成（`<html data-theme>` 换整套调色板）

## 9. 竞品对照：还缺什么

2026 年这个位置上真正该看的是 **Zotero 7**（离线优先、开源、插件生态）、
**Mendeley Reference Manager**（云端优先、PDF 阅读器最好、有 AI）和
**EndNote / Papers**（付费、机构场景）。对照下来，NG 的差距集中在"读"和"组织"两侧。

### 9.1 值得补的（按性价比排序）

| 竞品能力 | Zotero 7 | Mendeley RM | NG | 说明 |
| --- | :-: | :-: | :-: | --- |
| 按标识符添加条目 | ✅ | ⚠️ | ✅ | `GET /catalog?doi=` 可用，成本极低 |
| PDF 目录 / 大纲 | ✅ | ❌ | ✅ | `pdf.getOutline()` 现成的 |
| 适配宽度 / 整页缩放 | ✅ | ✅ | ✅ | 只有百分比缩放 |
| 标注侧栏（本篇/跨篇列表） | ✅ | ✅（Notebook） | ⚠️ | 本篇已做，跨篇列表见第 32 条 |
| 导出 EndNote XML | ✅ | ✅ | ✅ | 只有 BibTeX / RIS |
| 标签 | ✅ | ⚠️ | ✅ | API `tags` 可读写 |
| 星级 / 已读 | ❌ | ❌ | ✅ | API `starred` / `read` 可写 |
| 保存的搜索（智能文件夹） | ✅ | ❌ | ✅ | |
| 快捷键 / 键盘导航 | ✅ | ⚠️ | ⚠️ | Ctrl+F、字号、Ctrl+Z；列表导航见第 31 条 |
| 文献级笔记 | ✅ | ✅ | ⚠️ | **`/notes` 不存在**，只能本地存；已做，界面写明不同步 |
| 自定义文件重命名规则 | ✅ | ❌ | ✅ | 模板见第 27 条 |
| 正文内查找（Ctrl+F 定位到阅读器） | ✅ | ✅ | ❌ | 只有书目搜索，读的时候找不到词 |
| 复制格式化引文 | ✅ | ⚠️ | ❌ | 写稿时最高频的动作，见第 29 条 |
| 行右键菜单 | ✅ | ✅ | ❌ | 现在只有拖放和工具栏 |
| 键盘导航（↑↓ / Enter / Delete） | ✅ | ⚠️ | ❌ | 只有 Ctrl+F 与字号，见第 31 条 |
| 批量改元数据 | ✅ | ❌ | ❌ | 批量只覆盖文件夹 / 回收站 / 导出 |
| 全文检索 | ✅ | ✅ | ✅ | 每篇前 3 页，见第 9 条 |
| 连续滚动 | ✅ | ✅ | ✅ | 见第 11 条 |
| 附件预览 / 多附件 | ✅ | ❌ | ❌ | Mendeley 一条只有一个主文件 |
| 下划线 / 墨水 / 文本标注 | ✅ | ✅ | ❌ | 云端只认 highlight / sticky_note |
| 引用弹窗（悬停看参考文献） | ✅ | ❌ | ❌ | 锦上添花 |

### 9.2 补进路线图（接在上面的编号后面）

19. **按标识符添加条目**（P1）　✅ 已完成
    `GET /catalog?doi=...` 拿到 Mendeley 自己的编目记录，再 `POST /documents`。
    注意 **`?arxiv=` 参数不可靠**——实测 `1706.03762` 返回的是一篇无关的海报，
    arXiv id 要走 `export.arxiv.org` 那条路。
20. **PDF 目录（大纲）侧栏**（P2）　✅ 已完成：`pdf.getOutline()`，点条目跳页。
21. **缩放模式**　✅ 已完成：适配宽度 / 适配整页，和现有百分比并存。
22. **标注侧栏**（P2）　✅ 已完成（本篇），跨篇见第 32 条：列出本篇全部标注，点一条跳到对应页并选中。
23. **导出 EndNote XML**（P2）　✅ 已完成：补齐导入侧已有的第三种格式。
24. **标签 / 星级 / 已读**（P2，原 12 拆开）　✅ 已完成
    `tags` 可读写、`starred` / `read` 是文献自带字段，都能直接上云。
25. **文献级笔记**（P2）　✅ 已完成：**`/notes` 端点不存在**，只能落本地
    （`<userData>/library/notes.json`）并在 UI 里说明不会同步。
26. **保存的搜索**（P2）　✅ 已完成：把当前查询条件存成虚拟文件夹。
27. **自定义文件重命名**（P3）　✅ 已完成：模板 + 预览 + 应用到已有文件。

### 9.2b 第三轮缺口（2026-10-30，按用户视角补）

上一轮把"读"和"组织"的基本盘补齐了，剩下的差距不在能力清单上，而在
**每天都会做、现在却要做很多步才能做完**的动作上。逐条按性价比排序。

| 编号 | 功能 | 级别 | 为什么缺了难受 |
| --- | --- | --- | --- |
| 28 | **阅读器内查找** ✅ | P1 | 目录搜索能找到"哪篇"，读的时候却找不到"这个词在第几页"。Zotero / Mendeley 都有，是阅读器最基本的一条 |
| 29 | **复制格式化引文** ✅ | P1 | 写稿时最高频的动作：选中一篇 → 粘进稿子。现在只能导出整个 BibTeX 再自己找 |
| 30 | **行右键菜单** ✅ | P2 | 复制引文 / 加文件夹 / 移入回收站 / 打开 PDF 位置全都要先去工具栏或拖来拖去 |
| 31 | **键盘导航** ✅ | P2 | 5648 条的库用鼠标一行行点；↑↓ 选行、Enter 打开、Delete 入回收站是最基本的 |
| 32 | **跨篇标注列表** ✅ | P2 | 写完一篇要找"我之前在哪篇划过这句话"，现在只能一篇篇翻 |
| 33 | **批量改元数据** ✅ | P2 | 批量只覆盖文件夹 / 回收站 / 导出；给 50 篇统一加个标签或改类型做不到 |
| 34 | **打开 PDF 所在文件夹 / 用系统程序打开** ✅ | P3 | 想用别的阅读器或看原始文件时没有入口 |
| 35 | **设置面板** ✅ | P3 | PDF 目录、主题、字号、命名模板、全文索引页数散落在四个地方 |

实现要点（踩过的和要防的）：

- **28 不要引 pdf.js viewer**：它是 `pdfjs-dist/web` 的 `PDFFindController`，
  本工程用的是裸 `pdfjs-dist`，没有 viewer 层。自己用 `getTextContent()`
  拿 items（含 `transform`）建每页命中表，复用已有的文本层坐标换算来画高亮，
  缓存按 `文档+页` 存，翻页时才取。
- **29 的样式要能选**：至少 `Author et al. (Year)`、`Author (Year)`、`[n]` 编号、
  完整条目、BibTeX key。中文库里作者是 `last_name + first_name`，拼接要防重复。
- **31 要防输入框里吞键**：↑↓/Delete/空格在搜索框、笔记框、重命名框里必须照常工作，
  只在焦点不在输入控件时才当作导航键。
- **33 是写云端**：`tags` 追加要读回原值再合并；`starred` / `read` 是文献自带字段，
  直接 PATCH。批量失败要跳过而不是中断（同 `batchFolder` 的做法）。

这一轮新踩到的四个坑：

- **Ctrl+F 要用 capture 抢**：`App` 在 `window` 上先注册了全库搜索的 Ctrl+F，
  后注册的 bubble 监听一定排在它后面。阅读器用
  `window.addEventListener('keydown', h, true)` 再 `stopPropagation()`
  才能抢到；capture 阶段 stopPropagation 会连目标阶段一起掐掉。
- **file:// 别用 `navigator.clipboard`**：渲染进程是 `loadFile` 出来的 file://
  页面，异步剪贴板能不能用取决于权限策略，静默失败最难查。走 Electron 的
  `clipboard` 模块，顺便让冒烟能 `readClipboard()` 回读验证。
- **`onBlur` 在冒烟里要派发 `focusout`**：React 把 `onBlur` 映射成原生
  `focusout`，派发 `new FocusEvent('blur')` 会被吞。省事的办法是走
  `keydown Enter` 那条提交路径。
- **虚拟列表要 `scrollToIndex(i, { align: 'auto' })`**：键盘把选区移到屏幕外的行时，
  不滚过去看起来就像没反应；`auto` 保证已经可见的行不动，鼠标点击不会跳。

### 9.2c 第四轮缺口（2026-10-31，建索引卡死之后）

前三轮补齐了「读」和「组织」的能力清单。这一轮不再看能力，只看**每天开软件
就会遇到、现在却要手动重来一遍**的事：打开要重新拖窗口、读过的论文回到第 1 页、
写了摘要却搜不到、每次都要先点同步。全部只用已有本地数据或已在用的端点。

| 编号 | 功能 | 级别 | 为什么缺了难受 |
| --- | --- | --- | --- |
| 36 | **阅读位置记忆** | P1 | 5600 篇，读到第 17 页关掉，下次打开回到第 1 页重新翻。每天都发生 |
| 37 | **检索覆盖摘要 / 关键词 / 标签 / 类型 / 本地笔记** | P1 | 现在只搜 title / source / key / doi / authors。填了摘要、打了标签、写了笔记的全搜不到——「我明明记得写过」的源头 |
| 38 | **启动自动增量同步 + 显示上次同步时间** | P1 | 每天第一件事是手动点同步，忘了就对着旧数据干活。增量无改动只要 3 秒 |
| 39 | **窗口尺寸 / 位置 / 最大化记忆** | P2 | 每次启动重新拖窗口和两条分隔条 |
| 40 | **筛选开关：未读 / 无本地 PDF / 云端有本地没有 / 未归文件夹** | P1 | 5600 篇最常问的四件事，现在只有 ★ 一个开关，数据全在本地 |
| 41 | **批量下载「云端有、本地没有」的 PDF** | P2 | 约一成条目云端有文件本地没有，几百篇只能一篇篇点下载 |
| 42 | **批量移出文件夹** | P2 | 整理时「把这批从 Inbox 拿出来」是高频，批量条现在只有「加入」 |
| 43 | **查重忽略标记** | P3 | 每次点查重全库重算，标题相同但不是重复的（rebuttal 之类）要一遍遍重新判断 |
| 44 | **阅读器键盘翻页**（Space / PageDown / Home / End） | P2 | 读 40 页全靠点 ←/→，阅读器里现在只有 Ctrl+F |
| 45 | **Ctrl+A 全选结果 / Esc 取消选择** | P2 | 取消选择现在要移鼠标去点按钮 |
| 46 | **导出走保存对话框** | P2 | 永远写 `library.bib` 到下载目录，第二次导出变成 `library (1).bib` |
| 47 | **详情面板补齐字段**（type / volume / issue / pages / publisher / url / keywords） | P1 | `Doc` 有这些字段、PATCH 也能写，界面上却没有入口；改类型只能走批量，卷期页码完全填不了 |
| 48 | **排序 / 当前文件夹记忆** | P3 | 每次启动回到「年份倒序 + 全部文献」 |

实现要点（这一轮要防的）：

- **36 别把旧文档的页码写串**：`PdfViewer` 在 `doc` 变化时会先把 `page` 置 1，
  写回必须挂在「文档已稳定」之后，否则切文档那一帧会把 1 写进上一篇。
- **37 要缓存**：5600 条每次重算拼接串会卡输入。用 `Map<id, string>` 缓存 hay，
  只在 docs / notes 变化时重算。
- **38 要先问 `hasToken()`**：没有 token 时同步会抛 `NO_TOKEN`，启动就弹红条很难看。
  自动同步也要能在设置里关掉。
- **44 会和列表抢键**：`App` 的全局 handler 在 canvas 上 `claimed` 为 false，
  ↑↓ 会被抢去改列表选中行。按第 28 条记的 capture 规则在阅读器里 `stopPropagation`。
- **41 必须限流**：S3 预签名下载并发高了会被拒，照 `ft:build` 那套
  「后台跑 + 推进度 + 可取消」，并发 2–3、失败跳过。
- **47 的 `type` 只能用白名单**：服务端只接受固定集合（见第 5 节第 12 条），
  复用 `BatchEdit` 那份列表。
- **Ctrl+滚轮缩放不能用 React 的 `onWheel`**：React 把 `wheel` 注册成 passive
  listener，`preventDefault()` 会被忽略，结果变成整个窗口缩放而不是页面缩放。
  必须 `window.addEventListener("wheel", h, { passive: false, capture: true })`。
  也不能挂在 pane 元素上——文档没加载时 pane 还不在 DOM 里。
- **高亮不要默认开着**：拖框即高亮会把「选中一句话去复制」变成「在纸上留一块黄」，
  而且不留痕迹、等发现时整页都是。做成开关，默认关，开启时指针变十字——
  一个改了拖拽含义的模式，不该要求用户先去读工具条才知道自己在里面。
  也**不记忆**它（连续滚动才记忆）：阅读习惯值得跨会话带走，绘图工具不值得，
  一次忘关就把这个默认值悄悄推翻了。

### 9.2d 第五轮：打磨细节（2026-11，图标与缩放之后）

前四轮都在补能力。这一轮什么都不补，只处理**用起来不顺手**的地方：
一条错误挂着不走、浅色主题下每行压一条黑线、浮层只能用鼠标关、
换个文件夹右栏还显示着已经不在列表里的那篇。每一条都不需要新接口、
不需要新数据，改的是每天都会撞到的那几秒。

| 编号 | 打磨什么 | 为什么难受 |
| --- | --- | --- |
| 49 | **错误条可关闭** | `err` 一旦出现就一直挂在顶部，只有下一次操作才会顶掉它；读完想关关不掉 |
| 50 | **表格 / 查重里的硬编码深色跟上主题** | `DocTable` 行底是 `1px solid #2c2c2c`，`DupesView` 选中行是 `#1f2a20`，浅色主题下是黑线压黑底 |
| 51 | **Esc 关掉浮层** | 设置和列选择只能靠鼠标关，而设置盖住整个窗口——恰恰是最想按键的时候 |
| ~~52~~ | ~~列选择点外面就收起~~ | 不必做：`.col-picker` 上已经有 `onMouseLeave={onClose}`，鼠标一离开卡片就收起 |
| 53 | **换筛选后不再留「幽灵」文献** | `selId` 不随筛选失效：搜个词之后右栏还显示那篇，而「复制引文」会作用到一篇列表里看不见的文献 |
| 54 | **Ctrl+A 全选当前结果 / Esc 取消多选** | 5600 篇里挑 200 篇只能 shift 拖到底；取消多选现在要把鼠标移到「取消选择」按钮上 |
| 55 | **导出走保存对话框** | 永远写 `library.bib`，第二次导出变成 `library (1).bib`，也不知道写到哪去了 |
| 56 | **阅读器键盘翻页**（Space / PageUp / PageDown / Home / End） | 读 40 页全靠点 ←/→。阅读器里现在只有 Ctrl+F |
| 57 | **排序记忆** | 每次启动回到「年份倒序」 |
| 58 | **窗口尺寸 / 位置 / 最大化记忆** | 每次启动重新拖窗口；分隔条宽度已经记了，窗口没有 |
| 59 | **拖 PDF 导入别读两遍** | `onDrop` 里 `await f.arrayBuffer()` 调了两次，一篇 20 MB 就是 40 MB 的读盘和内存 |
| 60 | **导入 / 下载 PDF 后自动加入全文索引** | 导入一篇之后它在全文检索里是不存在的，直到整库重建；而重建要几分钟，所以最新的一篇——最可能去找的那篇——恰恰搜不到 |
| 61 | **文件夹按名称排列** | 根层原先按文献数量降序，子文件夹干脆是云端返回的原序：一个文件夹落在哪全看它碰巧在哪，找一个要从上往下读一遍 |

9.2c 里还没做的（38 启动自动同步、39 窗口记忆、40 筛选开关、41 批量下载、
42 批量移出、43 查重忽略、44 阅读器翻页、45 Ctrl+A/Esc、46 导出对话框、
47 详情字段、48 排序记忆）继续有效，其中 39/44/45/46/48 已并进上表，
剩下的照原编号排队。

实现要点（这一轮要防的）：

- **49 别给 `batchMsg` / `importMsg` 也加关闭按钮**：它们 2.5 秒自己消失，
  再加一个叉是重复。只有 `err` 需要——它是唯一会一直停在那儿的，而且
  同步失败的原因需要时间读，**所以它不自动消失，只给一个关闭**。
- **50 光改 CSS 变量没用**：颜色写在 inline style 里，优先级高于 class，
  必须把 inline 那行删掉，让它落到 `.row` / `.dupe-row` 的 CSS 上，
  再由 `[data-theme=light]` 去翻。
- **51 Esc 归 `App` 统一管，一次只关最上面那个**：`PdfViewer` 已经在用 Esc 关查找框，
  但只在查找框开着时 `stopPropagation`，所以关着的时候 Esc 能正常冒泡到 `App`。
  `App` 的 handler 里 `settings` / `showCols` 是 state，**依赖数组必须带上它们**——
  闭包在挂载时捕获的是 false，Esc 会彻底没反应。
  候选元数据框**不加** Esc：它长在右栏里、自带「收起」按钮，而一个内嵌面板抢走
  Esc 之后，外面真盖住窗口的浮层就再也收不到了。
- ~~52~~ 已取消，见上表。
- **53 不能一刀切清空 `selId`**：切列顺序、改字号都不碰 `filtered` 的内容，
  不该清。只在**当前 `filtered` 里找不到 `selId`** 时才让选中失效，
  而且要保留 `multi` 里其它仍然可见的选中项。
- **54 Ctrl+A 在搜索框里必须还是全选文本**：`App` 的 keydown 里 `claimed`
  已经排除了 `INPUT` / `TEXTAREA`，所以只需处理焦点在 body 的情况——
  在那里不 `preventDefault()` 会把整页文字都选上。
- **55 保存对话框只能走 IPC**：渲染进程碰不到 `fs`。新增一个
  `export:save`，main 里 `dialog.showSaveDialog` 拿路径再 `writeFile`，
  取消时返回 `null`，不能写一个空文件出来。
- **56 会和列表抢键**：`App` 的全局 handler 在 canvas 上 `claimed` 为 false，
  Space 会滚整个窗口、Home/End 会跳列表首尾。按第 28 条记的 capture 规则
  在阅读器里 `stopPropagation`。
- **60 追加和全量建索引不能同时写 `.dat`**：两者都从 entry 表推算"从哪里开始写"，
  并发会把两篇放在同一个偏移上，之后其中一篇的每个命中都会记到另一篇头上。
  用一个 `busy` 互斥（`building` 不行，它带着"正在建索引"的 UI 含义）。
- **60 追加完必须 `blob = null`**：全文是内存里缓存的一整个字符串，不清掉的话
  导入后立刻搜索读的还是文件里的旧文本，新论文照样搜不到。
- **60 entry 表为空时不能追加**：改页数预算会丢掉 entry 表但 `.dat` 还在，
  此时偏移从 0 重新计而文本写在文件末尾，命中会记到别的文献头上。
  `ftBuild` 的增量路径有同一个陷阱，一并堵了。
- **60 不阻塞导入**：`ftAdd` 不 await，导入的 IPC 照常回答。一个 PDF 零点几秒，
  但它是后台的事，不该让人等。
- **61 排序放在 `buildTree` 里，不在渲染处**：`byName` 从 `lib/tree.ts` 导出，
  文件夹列、「加入文件夹」下拉、详情面板三处都用它，否则每处各自排一遍、
  迟早不一致。子层也要排——`children` 原来完全没排。
- **61 `numeric` 与 `sensitivity: 'base'` 都要**：前者让「第 2 章」在「第 10 章」
  前面，后者让只差大小写的两个名字不被甩到列表两端。
- **61 冒烟只比根层**：子文件夹列在父文件夹下面，整列不是一条字母序列，
  拿全列比会误报。用 `paddingLeft === "8px"` 挑出根层。
- **58 在 `close` 里写，不在 `resize` 里写**：`resize` 一秒几十次，
  每次写一次 config.json 是没人要求的磁盘写入。照 `panesTouched` 那套节流；
  最大化要用 `isMaximized()` 单独存，不能靠宽高去猜。

### 9.2e 第六轮：从能跑到能用（2026-11，按用户旅程）

前面几轮补能力、磨手感。这一轮换一个问题：**一个第一次打开它的人，能不能
自己用起来。**

现在的界面默认你已经知道：要先有 token、要设 PDF 目录、要点同步、全文要自己
建一次索引、导出会写到下载目录且第二次叫 `library (1).bib`、拖过页面会留下高亮。
每一条都写在某个按钮的 `title` 里，但没有一条在你撞上它的那一刻说出来——
这是 demo 和产品最本质的差别：demo 假设你知道，产品在你需要的时候告诉你。

所以这一轮不按功能排，按**一天里真正会发生的事**排：

| 编号 | 场景 | 现在 | 应该 |
| --- | --- | --- | --- |
| 62 | **第一次打开** | 22 个按钮平铺，「导入 token」（一次性）和「同步云端」（每天）一样大 | 首屏是一张引导卡片：没有 token 就说清要什么、从哪来；有了就引导设 PDF 目录；都齐了才是库 |
| 63 | **库是空的 / 搜不到** | 「没有匹配的文献」——库里没东西、筛选太窄、搜索没命中，三件事同一句话 | 三种情况分开说，各给一条出路（"清空筛选" / "试试全文检索"） |
| 64 | **选中一条但没有 PDF** | 右栏 PDF 页空白 | 给三个具体动作：从云端下载、拖一个进来、改 PDF 目录 |
| 65 | **全文检索没建索引** | `0 / 5648`，用户要自己想到去点「建索引」 | 就在那句话旁边说明"还没建过，第一次几分钟"，并把按钮放在旁边 |
| 66 | **批量操作跑很久** | 逐条写云端，期间只有一个按钮变灰 | 有进度、能停、结束时报告「成功 N 条，失败 M 条」——悄悄少几条最伤信任 |
| 67 | **导出** | 永远写 `library.bib` | 保存对话框 |
| 68 | **工具栏** | 22 个按钮平铺，窄窗口挤掉后半截 | 分三级：常用的留在外面，低频的进「更多」，一次性的只在需要时出现 |
| 69 | **筛选** | 只有 ★ 一个开关 | 未读 / 无本地 PDF / 云端有本地没有 / 未归文件夹 |
| 70 | **键盘** | 只有 ↑↓ Enter Delete Ctrl+F Ctrl+Z | Ctrl+A 全选结果、Esc 取消多选、F2 重命名文件夹 |

实现要点（这一轮要防的）：

- **62 引导不能挡住老用户**：只在真的缺东西时出现（`hasToken()` 假、或
  PDF 目录没设、或库里没有文献）。已经能用的库不该每次启动都看到它。
- **62 别在启动时弹窗**：`hasToken()` 在 `app.whenReady` 之前读不到 userData。
  引导是渲染进程里的一张卡片，不是 `dialog`。
- **63 三种空态要能区分**：`docs.length === 0`（库空）、
  `filtered.length === 0 && docs.length > 0`（筛掉了）、
  以及搜索词本身。判断顺序写反会把"库是空的"说成"没搜到"。
- **66 失败要留名**：批量 200 条里 3 条失败，用户需要知道是哪 3 条，
  一句"部分失败"等于没说。逐条 PATCH 没有事务，本来就可能部分成功。
- **68 动工具栏先想冒烟**：81 条断言里有十几条是按按钮文字找按钮的
  （`textContent.trim()==="设置"`）。收进菜单后这些要一起改，
  否则会出现"功能还在、测试找不到它"的假失败。
- **69 四个开关不是互斥的**：可以同时"未读 + 无本地 PDF"，
  组合后的计数要在 badge 上说得清。

### 9.3 差距可以接受，先不做

- **下划线 / 墨水 / 文本标注**：云端 `/annotations` 只认 `highlight` 与 `sticky_note`，
  硬做会变成"本地能画、云端丢一半"，不如只做高亮做扎实。
- **多附件 / 快照 / EPUB**：Mendeley 一条就一个主文件，EPUB 不在产品定位里。
- **附件预览**：要渲染缩略图，收益低于连续滚动。
- **浏览器扩展抓取**：用"按标识符添加"+"拖 PDF"覆盖了大部分场景。
- **AI 摘要 / 问答**：Mendeley 的卖点，但 NG 的定位是本地快、离线可用，
  接 LLM 会把"不联网也能用"这个最大的优点搭进去。

## 10. 明确不做（以及为什么）

写下来是为了避免后来人热心补回来：

- **Word / LibreOffice 引用插件**：要做就得引入 CSL + citeproc + 各办公软件的插件体系，
  是另一个量级的工程，而且官方已有 Mendeley Cite 顶着。
  折中方案是 P1/P2 里做"复制格式化引文"（citeproc-js 渲染单条），成本低得多也能解决大半需求。
- **分组协作（Groups）**：1.19.8 最后一版已移除建组入口，API `/groups` 标了 deprecated。
- **相关文献推荐、站内文献检索（Literature Search）**：1.19.8 已移除，且依赖已下线的社交图谱。
- **个人主页、关注者等社交功能**：同上，随 Mendeley 产品线一起下线了。

## 11. 仓库历史注意事项

- 远端 `https://github.com/shenyunhang/Mendeley-NG`，分支 `main`。
- **历史被重写过一次**（用 `git filter-repo` 清除首提交里硬编码的个人路径），
  所以早期提交的 SHA 与任何旧 clone / fork 都不兼容。如果你手上有旧副本，重新 clone。
- 首提交里仍残留类似 `C:\Users\<name>\...` 的绝对路径字样（用户名已替换）。
  若要彻底抹掉，再跑一次 `git filter-repo --replace-text` 换成占位符即可。
- `post-commit` 钩子会自动推送。规范副本在 `scripts/hooks/post-commit`，
  新 clone 后需 `cp scripts/hooks/post-commit .git/hooks/post-commit && chmod +x ...`。
  临时不推用 `GIT_AUTO_PUSH=0 git commit ...`。
- 提交前务必确认没有 `token.json` / `.env` / 硬编码个人路径入库。已在 `.gitignore` 中拦截。

## 12. 数据与凭据放哪

| 内容 | 位置 |
| --- | --- |
| OAuth token | `<userData>/token.json`，或 `MENDELEY_TOKEN_PATH` 指向的路径 |
| 文献 / 文件夹缓存 | `<userData>/library/library.json` |
| 标注 | `<userData>/library/annotations.json` |
| 配置（PDF 目录、字号） | `<userData>/library/config.json` |

`<userData>` 在 Windows 上是 `%APPDATA%\mendeley-ng`。
**这些都不在仓库里**，换机器需要重新导入 token。
