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
| 文件夹增删（拖拽 / 勾选） | 可用 |
| BibTeX / RIS 导出 | 可用 |
| 界面字号调节 | 可用 |
| Windows 安装包（NSIS） | 可构建，未签名 |

未签名意味着 Windows 会弹 SmartScreen，自用点"仍要运行"即可。

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

## 7. 可以往下做的地方

按性价比排序：

1. **标注的删改**：现在只能加高亮，不能删也不能加笔记。IPC 与存储都已就绪，缺 UI。
2. **连续滚动 / 预取相邻页**：现在一次只渲染当前页，翻页有等待。
3. **PDF 内搜索**：pdf.js 有 text layer，目前没接。
4. **标注同步到云端**：Mendeley API 有 `/annotations`，目前标注只存本地 JSON。
5. **安装包签名**：消除 SmartScreen 警告。
6. **深浅色切换**：现在只有深色。

## 8. 仓库历史注意事项

- 远端 `https://github.com/shenyunhang/Mendeley-NG`，分支 `main`。
- **历史被重写过一次**（用 `git filter-repo` 清除首提交里硬编码的个人路径），
  所以早期提交的 SHA 与任何旧 clone / fork 都不兼容。如果你手上有旧副本，重新 clone。
- 首提交里仍残留类似 `C:\Users\<name>\...` 的绝对路径字样（用户名已替换）。
  若要彻底抹掉，再跑一次 `git filter-repo --replace-text` 换成占位符即可。
- `post-commit` 钩子会自动推送。规范副本在 `scripts/hooks/post-commit`，
  新 clone 后需 `cp scripts/hooks/post-commit .git/hooks/post-commit && chmod +x ...`。
  临时不推用 `GIT_AUTO_PUSH=0 git commit ...`。
- 提交前务必确认没有 `token.json` / `.env` / 硬编码个人路径入库。已在 `.gitignore` 中拦截。

## 9. 数据与凭据放哪

| 内容 | 位置 |
| --- | --- |
| OAuth token | `<userData>/token.json`，或 `MENDELEY_TOKEN_PATH` 指向的路径 |
| 文献 / 文件夹缓存 | `<userData>/library/library.json` |
| 标注 | `<userData>/library/annotations.json` |
| 配置（PDF 目录、字号） | `<userData>/library/config.json` |

`<userData>` 在 Windows 上是 `%APPDATA%\mendeley-ng`。
**这些都不在仓库里**，换机器需要重新导入 token。
