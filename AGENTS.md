# AGENTS.md — eda-sch-beautify

给在本仓库工作的 AI / 自动化助手用的简短说明。人类可读文档见根目录 [`README.md`](README.md) 与 [`extension/README.md`](extension/README.md)。

## 项目是什么

嘉立创 EDA 专业版（EasyEDA Pro）原理图 **导出后** 美化：在 SVG 不相连交叉处加半圆跨线弧（参考 KiCad 10 hop-over）、节点跟导线颜色、删灰色未连接标记、中文宋体 / 英文 Times New Roman、去整页背景，并可导出 PNG（1x/2x/4x，透明 / 白 / 纸色 `#F5F4EF`）。**不修改原理图本身。**

两条入口：

- 扩展：`extension/` → 根目录 `npm run setup && npm run build`（或 `extension/build.sh`）→ `extension/dist/eda-sch-beautify_v*.eext`
- Python CLI：`python/eda_sch_beautify.py`（算法与扩展核心应对齐）

## 工作约定

- **规范仓库**：以本仓库（GitHub `totok22/eda-sch-beautify` 的 clone）为准；不要把未同步的旁路目录当主线。
- **不要提交**：`node_modules/`、本机私密路径、未脱敏的用户原理图。示例用 `examples/example.svg`（真实 EasyEDA Pro 导出）。
- **扩展构建 / 测试**：`extension/` 下没有 `node_modules` 时先 `npm run setup`（= `npm --prefix extension ci`），也可以临时 symlink 到已装好的 SDK 依赖。`npm run build` 走 `build/build-all.ts`（跨平台，会自己建 `build/dist/` 并清空 `extension/dist/`），`build.sh` 是等价的 macOS/Linux 备用路径。产物进 `extension/dist/`。改核心算法后跑 `npm run test`（`extension/test/test-core.ts`，有断言，只用 `examples/example.svg` 和合成用例）。
- **发布**：版本号在 `extension/extension.json`、`extension/package.json`、`extension/package-lock.json`（两处）同步改，并在 `extension/CHANGELOG.md` 写条目 → `npm run test && npm run build` → 推送 main → GitHub release（tag `v<版本>`，标题同 tag，正文用 CHANGELOG 要点 + 一行“安装包：`eda-sch-beautify_v<版本>.eext`”，附件就是 `extension/dist/` 里的 `.eext`）。扩展广场需要另外手动上传同一个 `.eext`，审核通过后才会上架。
- **面板性能 / 清晰度**（`extension/src/iframe-app.ts`，见 `extension/CHANGELOG.md` 0.3.1）：
  - 预览是栅格位图（`<canvas>`），不是矢量 SVG：`#preview` 全页底图（最长边 ≤2048、DPR 封顶 2）+ `#previewHi` 可视区细节层（操作停下约 140 ms 后按“缩放 × DPR”重绘，位图 ≤8192 边 / 16M 像素）。两层从不同时可见（透明背景下会叠色）。
  - 缩放/平移只改 `#layer` 这一层的 `transform`，每帧至多写一次（rAF）；导出区域框 `#selbox` 画在 `#layer` 外，边框恒为 2px。
  - 禁止：把整页矢量 SVG 塞进受 CSS `scale` 的 DOM；`backdrop-filter` / 大面积 `box-shadow` 盖在画布上；主题轮询（用 `matchMedia` + `focus` / `visibilitychange`）；在 mousemove / wheel 里对整份 SVG 字符串做正则或重新栅格化。
  - 只改背景 / 倍率 / 边距时不得重跑 `processSvg`（走 `restyle()` / `updateSelBox()`）。
  - 改完用无头 Chrome 对 2MB 级的大 SVG（把 `examples/example.svg` 平铺成 8×8）量滚轮、平移、框选拖动的帧时间，并放大到 400% 看截图是否锐利。

## 关键源码

| 路径 | 作用 |
| --- | --- |
| `extension/src/index.ts` | 扩展入口：菜单、快速导出 SVG、打开面板 |
| `extension/src/sch-beautify-core.ts` | 跨线弧 / 节点 / 标记 / 字体 / 去背景（与 Python 逻辑对应） |
| `extension/src/iframe-app.ts` | 面板逻辑：导出、预览栅格化、PNG canvas、区域 |
| `extension/src/panel.html` | 面板 HTML / CSS |
| `extension/extension.json` | 扩展清单（版本、菜单、logo/banner） |
| `extension/build/build-all.ts` / `extension/build.sh` | 打包 `.eext`（前者跨平台，`npm run build` 用它） |
| `extension/test/test-core.ts` | 核心算法回归测试（`npm run test`） |
| `python/eda_sch_beautify.py` | 命令行同名处理 |
| `examples/example.svg` | 文档与自测用示例 |
| `docs/screenshots/` | README 截图 |
| `NOTICE` | SDK 脚手架 Apache-2.0 归属 |
| `extension/CHANGELOG.md` | 扩展版本说明 |

## 扩展广场上架要求（摘要）

来源：[扩展广场说明](https://prodocs.lceda.cn/cn/api/guide/extensions-marketplace.html)。上传 `.eext` 前请核对：

1. `extension.json` 至少含 `name`、`uuid`、`displayName`、`description`、`version`、`license`；`categories` 至少填一项（本扩展用 `Schematic`）。
2. **自定义图标**：不得用 SDK 默认 logo；推荐 **1:1**，PNG 或 JPEG，清晰且无侵权风险，**≤ 5 MiB**（本仓库：`extension/images/logo.png`）。
3. `entry` 有效；不同扩展（不同 `uuid`）的 `name` 不得重复。
4. 扩展内 `README.md` 写清功能与用法；有更新时维护 `CHANGELOG.md`。
5. **禁止**包含个人隐私（电话等）。审核通过后才会在广场展示；可按命名空间 / 版本下架。

可选但本仓库已备：`images.banner`、`repository` / `homepage` / `bugs`（见 `extension/extension.json`）。

## References

### 嘉立创 EDA / EasyEDA Pro 扩展

- [什么是扩展 API？](https://prodocs.lceda.cn/cn/api/guide/) — 官方指南入口（中文）
- [如何开始](https://prodocs.lceda.cn/cn/api/guide/how-to-start.html) — SDK 环境、构建与导入 `.eext`（V2 / V3）
- [For AI 初始化扩展工程](https://prodocs.lceda.cn/storage/texts/api/guide/how-to-start-for-ai.md) — 给编程助手用的步骤稿
- [调用扩展 API](https://prodocs.lceda.cn/cn/api/guide/invoke-apis.html) — `eda` 对象与调试（`cll=debug`）
- [扩展配置文件 extension.json](https://prodocs.lceda.cn/en/api/guide/extension-json.html)
- [扩展广场说明](https://prodocs.lceda.cn/cn/api/guide/extensions-marketplace.html)（英文镜像：[Extensions Marketplace](https://prodocs.lceda.cn/en/api/guide/extensions-marketplace.html)）
- 英文文档镜像根：<https://prodocs.easyeda.com/en/api/guide/>

### 本扩展常用的 API 参考

- [`SYS_IFrame`](https://prodocs.lceda.cn/cn/api/reference/pro-api.sys_iframe.html) / [`openIFrame`](https://prodocs.lceda.cn/en/api/reference/pro-api.sys_iframe.openiframe.html) — 导出面板
- [`SCH_ManufactureData`](https://prodocs.lceda.cn/en/api/reference/pro-api.sch_manufacturedata.html) / [`getExportDocumentFile`](https://prodocs.lceda.cn/cn/api/reference/pro-api.sch_manufacturedata.getexportdocumentfile.html) — 导出 SVG（含 theme / size）
- 另见同模块的 `getSvgFile`，以及 `sys_FileSystem.saveFile`、`sys_Storage`、`sys_Window.getCurrentTheme`、`sch_SelectControl`（选区）

### SDK 与类型

- [easyeda/pro-api-sdk](https://github.com/easyeda/pro-api-sdk)（亦称 easyeda-api-sdk）— 官方扩展脚手架；本仓库 `extension/build`、`config`、工程骨架来自此处（Apache-2.0，见 `NOTICE`）
- npm 类型包：[`@jlceda/pro-api-types`](https://www.npmjs.com/package/@jlceda/pro-api-types)

### 扩展广场（上架 / 下载）

- 中文站：[jlc-ext.com](https://jlc-ext.com/)（EDA 扩展广场）
- 文档写明的站点：[jlcext.com](https://jlcext.com/)
- 本扩展在广场的页面：<https://jlc-ext.com/item/polioko/eda-sch-beautify>（`polioko` 是广场账号的命名空间；广场按 `uuid` 识别扩展，`extension.json` 的 `publisher` 只是展示用的开发者信息，与命名空间无关）
- 本扩展仓库：<https://github.com/totok22/eda-sch-beautify>
- Issues：<https://github.com/totok22/eda-sch-beautify/issues>

### KiCad 跨线弧（设计参考）

本项目的半圆跨线弧视觉参考 KiCad 10 schematic **wire hop-overs**（不相连交叉画成弧，非网表语义）：

- [KiCad 10 Schematic Editor — Wire hop-overs](https://docs.kicad.org/10.0/en/eeschema/eeschema.html)（Schematic Setup → Formatting → Hop-over size）
- [KiCad 10.0.0 发布说明（含 Hop-over display）](https://www.kicad.org/blog/2026/03/Version-10.0.0-Released/)
- 纸色背景 `#F5F4EF` 对齐 KiCad 默认原理图纸色

### 其它

- 扩展只处理导出的 SVG/PNG；算法入口以 `sch-beautify-core.ts` / `eda_sch_beautify.py` 为准，改行为时两边尽量同步（底板识别、单色配色两边已对齐；Python 不加背景矩形，所以没有“纯黑背景”）。
- 面板在 IFrame 内跑完整 DOM/Canvas；宿主页可能没有 `URL.createObjectURL`：SVG 转图片优先用 Blob URL，缺失或加载失败时退回 data URI；保存用 `canvas.toBlob`（失败再 `toDataURL`）。
