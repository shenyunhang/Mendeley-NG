# Mendeley NG

替代 Mendeley Desktop 1.19.8 的文献管理器。Electron + React + pdf.js。

写它的唯一理由：1.19.8 是 Qt 5.10.1 编译的，它声明自己感知 DPI 但支持不完整，
按物理像素渲染、不吃系统缩放倍率，所以在 3840×2400 的屏上字只有别的程序一半大，
改注册表强制 DPIUNAWARE 又会换来整窗模糊。Chromium 则是按系统 scale factor
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

## 首次使用

1. 应用会在常见位置找 Mendeley 的 `token.json`；找不到就点工具栏"导入 token"。
   token 里是 OAuth 的 client id/secret 与 refresh token，access token 过期会自动续。
2. 点"同步云端"拉全量。5648 条约 2–5 分钟，取决于 Mendeley 那边的响应速度。
3. 本地 PDF 目录默认是 Mendeley Desktop 的 `Downloaded` 目录，可在中间栏"改目录"更换。

## 它能做什么

| 功能 | 说明 |
| --- | --- |
| 浏览 | 三栏：文件夹树 / 文献列表 / 详情或 PDF。列表是虚拟滚动，5648 行不卡 |
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
scripts/check-api.mjs       API 冒烟测试（不启 GUI）
```

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
  元数据只能走云端 API。
- **主进程产物不能是 ESM**：package.json 里不要写 `"type": "module"`，
  否则 `require('electron')` 的 CJS 互操作会挂。
- **`app.quit()` 不接受参数**，要带退出码用 `app.exit(code)`。
