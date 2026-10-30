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
| 云端同步（文献 + 文件夹 + 文件挂载情况） | 可用 |
| 本地 PDF 目录扫描与匹配 | 可用 |
| 虚拟滚动列表（数千行不卡） | 可用 |
| 搜索 / 排序 | 可用 |
| PDF 阅读（pdf.js，高 DPI 清晰） | 可用 |
| 拖框高亮标注（本地持久化） | 可用 |
| 元数据编辑并 PATCH 回云端 | 可用 |
| 文件夹加入 / 移出（拖拽 / 勾选） | 可用；**不能重命名、移动或删除** |
| BibTeX / RIS 导出 | 可用；无导入 |
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
| PDF 高亮标注 | ✅ | ⚠️ | 可删除 / 改色 / 加笔记；矩形框而非文本选区 |
| 标注同步到云端 | ✅ | ✅ | 坐标须按 PDF 点换算，见第 6 节 |
| 云端 PDF 下载到本地 | ✅ | ✅ | `GET /files/{id}` 是 303 到 S3 预签名地址 |
| 导入文献（拖 PDF / BibTeX / RIS / EndNote） | ✅ | ✅ | 拖 PDF、BibTeX、RIS、EndNote XML |
| Update Details（补全元数据） | ✅ | ✅ | `/metadata` 未实现，走 Crossref + arXiv，见第 5 节 |
| 查重与合并 | ✅ | ✅ | 合并只补齐缺失字段，落败者进回收站 |
| 回收站 / 删除 / 恢复 | ✅ | ❌ | API 有 `/trash`、`POST /documents/{id}/trash` |
| 导出 BibTeX / RIS | ✅ | ✅ | 缺 EndNote XML |
| 库内检索（`/search/documents`） | ✅ | ⚠️ | 现在是本地过滤，没走 API，也没做高阶筛选 |
| 全文检索（搜 PDF 正文） | ✅ | ❌ | 需要文本层 + 本地索引 |
| 标签 / 笔记 / 星级 / 已读 | ✅ | ❌ | — |
| Word / LibreOffice 引用插件 | ✅ | ❌ | CSL + 插件体系，量级不同，见第 9 节 |
| 引用样式格式化（复制格式化引文） | ✅ | ❌ | 需引入 citeproc |
| 分组协作（Groups） | ⚠️ | ❌ | 1.19.8 已移除建组入口；API `/groups` 标 deprecated |
| 相关文献 / 站内文献检索 | ❌ | ❌ | 1.19.8 已移除，不做 |

## 8. 路线图

### P0 — 补齐读写闭环（API 已支持，风险低，收益直接）

1. **文件夹重命名 / 移动 / 删除 + 嵌套层级**
   `PATCH /folders/{id}`（改名或换 parent）、`DELETE /folders/{id}`。
   目前只能建和加，UI 里树是平的，1.19.8 支持子文件夹。
2. **删除与回收站**
   `POST /documents/{id}/trash`、`GET /trash`、恢复。
   没有删除入口意味着库里的垃圾只能去网页端清，这是日常最痛的缺口。
3. **标注同步到云端**
   `/annotations` 的 GET / POST / PATCH / DELETE 齐全。
   顺带把本地缺失的**删除、编辑、笔记**一起补了——现在只能加不能删。
   注意云端与本地的冲突策略要想清楚（以 `created` 时间戳还是以云端为准）。
4. **云端 PDF 下载**
   `GET /files/{id}` 拉到本地缓存目录。
   目前约一成的条目云端有文件但本地没有，这些现在完全读不了。

### P1 — 日常真正会用到

5. **导入：拖 PDF 进库**
   `POST /documents` 建条目，`POST /documents/{id}/files` 传文件。
   PDF 内嵌 DOI / arXiv ID 可以先抽出来查元数据，避免建成空条目。
6. **元数据补全（对标 Update Details）**
   Crossref + arXiv 查，查不到再退到 `/catalog` 搜。
   这块在旧项目里踩过大坑：**标题模糊匹配阈值 0.72 完全不可信**
   （"Object detection" vs "Lifelong Object Detection" 相似度 0.78，全是错配），
   必须提到 **0.90** 且短标题要关掉子串包含判断。宁可查不到也不要写错。
7. **查重与合并**
   本地按 DOI / 标题+年份 / filehash 分组给出候选集，
   人工逐字段确认后合并（保留一条 → 迁移文件夹 → 其余入回收站）。
   1.19.8 的合并是有字段级冲突预览和 Undo 的，值得照做。
8. **导入 BibTeX / RIS / EndNote XML**
   现在只有导出，没有导入，换库或迁移时会卡住。
9. **全文检索**
   pdf.js 出 text layer，本地建倒排索引。库大，索引要能增量更新并落盘复用。
10. **PDF 文本选区高亮**
    替换现在的矩形拖框，接 text layer 拿真实选区，顺带能复制文本。

### P2 — 打磨

11. **连续滚动 + 相邻页预取**（现在翻页有等待）
12. **标签、笔记、星级 / 已读状态**
13. **多选与批量操作**（批量改文件夹、批量删）
14. **增量同步**：`/deleted_documents` + 时间戳，现在每次全量拉，库大了很慢
15. **列定制与保存视图**
16. **撤销栈**（至少覆盖合并与删除）
17. **安装包签名**，消除 SmartScreen 警告
18. **深浅色切换**（现在只有深色）

## 9. 明确不做（以及为什么）

写下来是为了避免后来人热心补回来：

- **Word / LibreOffice 引用插件**：要做就得引入 CSL + citeproc + 各办公软件的插件体系，
  是另一个量级的工程，而且官方已有 Mendeley Cite 顶着。
  折中方案是 P1/P2 里做"复制格式化引文"（citeproc-js 渲染单条），成本低得多也能解决大半需求。
- **分组协作（Groups）**：1.19.8 最后一版已移除建组入口，API `/groups` 标了 deprecated。
- **相关文献推荐、站内文献检索（Literature Search）**：1.19.8 已移除，且依赖已下线的社交图谱。
- **个人主页、关注者等社交功能**：同上，随 Mendeley 产品线一起下线了。

## 10. 仓库历史注意事项

- 远端 `https://github.com/shenyunhang/Mendeley-NG`，分支 `main`。
- **历史被重写过一次**（用 `git filter-repo` 清除首提交里硬编码的个人路径），
  所以早期提交的 SHA 与任何旧 clone / fork 都不兼容。如果你手上有旧副本，重新 clone。
- 首提交里仍残留类似 `C:\Users\<name>\...` 的绝对路径字样（用户名已替换）。
  若要彻底抹掉，再跑一次 `git filter-repo --replace-text` 换成占位符即可。
- `post-commit` 钩子会自动推送。规范副本在 `scripts/hooks/post-commit`，
  新 clone 后需 `cp scripts/hooks/post-commit .git/hooks/post-commit && chmod +x ...`。
  临时不推用 `GIT_AUTO_PUSH=0 git commit ...`。
- 提交前务必确认没有 `token.json` / `.env` / 硬编码个人路径入库。已在 `.gitignore` 中拦截。

## 11. 数据与凭据放哪

| 内容 | 位置 |
| --- | --- |
| OAuth token | `<userData>/token.json`，或 `MENDELEY_TOKEN_PATH` 指向的路径 |
| 文献 / 文件夹缓存 | `<userData>/library/library.json` |
| 标注 | `<userData>/library/annotations.json` |
| 配置（PDF 目录、字号） | `<userData>/library/config.json` |

`<userData>` 在 Windows 上是 `%APPDATA%\mendeley-ng`。
**这些都不在仓库里**，换机器需要重新导入 token。
