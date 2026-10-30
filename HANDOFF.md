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
| PDF 阅读（pdf.js，高 DPI 清晰） | 可用；适宽 / 整页缩放、目录侧栏 |
| 文本选区高亮（本地持久化 + 云端同步） | 可用 |
| 元数据编辑并 PATCH 回云端 | 可用 |
| 文件夹树（建 / 改名 / 移动 / 删除 / 嵌套） | 可用 |
| 导入 BibTeX / RIS / EndNote XML；导出这三种 | 可用 |
| 按 DOI / arXiv id 添加条目 | 可用 |
| 星标 / 已读 / 标签 | 可用；写回云端 |
| 批量操作（Shift / Ctrl 多选） | 可用 |
| 自更新（GitHub Releases） | 可用 |
| 界面字号调节 | 可用 |
| Windows 安装包（NSIS） | 可构建，未签名 |

未签名意味着 Windows 会弹 SmartScreen，自用点"仍要运行"即可。
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
  `files` 已收紧为 `["out/**/*","package.json","!node_modules/**"]`。
  如果以后主进程真的需要运行时依赖，记得把它加回去，否则 packaged build 会炸。

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
9. **全文检索**
   pdf.js 出 text layer，本地建倒排索引。库大，索引要能增量更新并落盘复用。
10. **PDF 文本选区高亮**　✅ 已完成
    替换现在的矩形拖框，接 text layer 拿真实选区，顺带能复制文本。

### P2 — 打磨

11. **连续滚动 + 相邻页预取**（现在翻页有等待）
12. **标签、笔记、星级 / 已读状态**　✅ 标签 / 星级 / 已读已完成（笔记拆到第 25 条）
13. **多选与批量操作**（批量改文件夹、批量删）　✅ 已完成
14. **增量同步**　✅ 已完成：只用 `GET /documents?modified_since=`。
    **`/deleted_documents` 是 404**，删除没有增量通道，只能靠「全量」按钮，
    UI 里也写明了这一点。实测无改动时 3 秒，一小时前的增量 93 秒。
15. **列定制与保存视图**
16. **撤销栈**（至少覆盖合并与删除）
17. **安装包签名**，消除 SmartScreen 警告
18. **深浅色切换**（现在只有深色）

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
| 标注侧栏（本篇/跨篇列表） | ✅ | ✅（Notebook） | ⚠️ | 本篇已可做，跨篇列表没做 |
| 导出 EndNote XML | ✅ | ✅ | ✅ | 只有 BibTeX / RIS |
| 标签 | ✅ | ⚠️ | ✅ | API `tags` 可读写 |
| 星级 / 已读 | ❌ | ❌ | ✅ | API `starred` / `read` 可写 |
| 保存的搜索（智能文件夹） | ✅ | ❌ | ❌ | — |
| 快捷键 / 键盘导航 | ✅ | ⚠️ | ⚠️ | 只有 Ctrl+F 和字号 |
| 文献级笔记 | ✅ | ✅ | ❌ | **`/notes` 不存在**，只能本地存 |
| 自定义文件重命名规则 | ✅ | ❌ | ❌ | 现在固定 `作者 - 年份 - 标题` |
| 全文检索 | ✅ | ✅ | ❌ | Zotero 7 起不再依赖 pdftotext |
| 连续滚动 | ✅ | ✅ | ❌ | — |
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
22. **标注侧栏**（P2）　✅ 已完成（本篇），跨篇未做：列出本篇全部标注，点一条跳到对应页并选中。
23. **导出 EndNote XML**（P2）　✅ 已完成：补齐导入侧已有的第三种格式。
24. **标签 / 星级 / 已读**（P2，原 12 拆开）　✅ 已完成
    `tags` 可读写、`starred` / `read` 是文献自带字段，都能直接上云。
25. **文献级笔记**（P2）：**`/notes` 端点不存在**，只能落本地
    （`<userData>/library/notes.json`）并在 UI 里说明不会同步。
26. **保存的搜索**（P2）：把当前查询条件存成虚拟文件夹。
27. **自定义文件重命名**（P3）：模板化重命名已下载的 PDF。

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
