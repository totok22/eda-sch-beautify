# 原理图美化导出 eda-sch-beautify

给 **嘉立创EDA专业版（EasyEDA Pro）** 原理图导出的 SVG / PNG 做“出版级”美化：

- 不相连的导线交叉处加 **半圆跨线弧**（KiCad 10 风格：水平线向上鼓；相邻交叉等大缩小或合并；避开节点/引脚/文字）
- **节点圆点跟随导线颜色**（告别默认千篇一律的红色圆点）
- 删除灰色的 **未连接标记**（× / 灰色端点圆圈）
- **中文用宋体、英文保持 Times New Roman**（出版级中英文衬线混排）
- 智能彻底剥离 EDA 导出自带的图纸底板，无缝支持 **透明 / 白色 / KiCad 经典纸色 (#F5F4EF) / 纯黑**，告别背景割裂
- 支持 **整页**、**选中图元（支持边距留白微调）**、**交互式手动框选** 导出
- 支持 **默认彩色**、**出版级白底黑线（单色）**、**高对比度黑底白线**
- 导出面板采用中性的深灰 / 黑色风格，PNG 支持 **1x / 2x / 4x / 6x** 倍率，背景底色可直接选 **纸色 / 白 / 浅灰 / 深灰 / 黑 / 透明**

> **说明**：本插件只处理导出的 SVG / PNG 图片文件，**不会修改原理图工程本身**。

![面板（浅色）](docs/screenshots/panel_light.png)
![面板（深色）](docs/screenshots/panel_dark.png)
![跨线弧前后对比（上：原图，下：处理后）](docs/screenshots/hop_before_after.png)
![整页前后对比：未连接标记、节点颜色、中文宋体](docs/screenshots/markers_font_before_after.png)

示例原理图：[`examples/example.svg`](examples/example.svg)

---

## 核心参数与选项详解

### 1. 导出配色（Color Themes）
| 配色模式 | 表现与应用场景 |
|---|---|
| **默认（跟随 EDA）** | 保留原理图原本的彩色连线与元器件颜色（例如蓝色 CAN 总线、绿色信号线、深红引脚等）。 |
| **白底黑线（Black on White）** | 将所有连线、元器件框线、文字、引脚与实心节点圆点**统一转换为纯黑色（#000000）**。专为**学术论文、学位论文、专利附图、黑白书籍印刷**打造，告别彩色杂乱感。 |
| **黑底白线（White on Black）** | 将所有连线与文字反色转换为纯白色（#FFFFFF），适合深色 PPT、技术汇报或暗黑系文档展示。选择它时背景会自动切到「纯黑」，否则白线画在白底 / 纸色上是看不见的。 |

> 配色与背景是两个独立选项：配色只改线条、文字和填充的颜色，背景由下面的「背景底色」决定。单色转换不会动 `<mask>` / `<pattern>` 里的图案填充。

### 2. 导出范围与边距（Export Region & Margin）
* **整页**：导出当前原理图完整画幅。
* **选中图元**：先在嘉立创原理图编辑器中选中需要的模块（元器件与走线），点击「读取选中」即可精准截取该电路块。
  * **边距（Margin，默认 10）**：在选中图元的外接包围盒四周**额外向外扩出的空白留白间距**。
    * 若边距为 `0`，导出框将死死贴着最外层的引脚或走线边缘，视觉局促甚至可能切断半个像素；
    * 边距为 `10`（约 10px / 1~2 个网格格点），能为电路模块四周提供舒适的美感呼吸感与排版留白。
* **手动框选**：在交互预览画板中直接使用鼠标拖拽出虚线框，任意自由截取局部电路。

### 3. PNG 背景底色（Background）
* **KiCad 纸色 (`#F5F4EF`)**：KiCad 经典浅米黄暖色底，柔和护眼，大幅提升工程高级感。
* **纯白 (`#FFFFFF`)**：现代标准纯白底色，适合通用技术文档与网页。
* **浅灰 (`#F2F2F2`)**：接近 Word / 网页的默认灰色底，适合技术文档和截图拼版。
* **深灰 (`#1E1E1E`)**：深色 PPT、技术汇报和暗色文档的常用底色，比纯黑柔和。
* **纯黑 (`#000000`)**：配合「黑底白线」使用。
* **完全透明**：真透明背景（彻底去除原图纸白色大底板），可无缝贴入深色/彩色 PPT 演示文稿、Word 及 Markdown 中而不显突兀白边。

面板里这六种底色都做成了分段按钮，单击即可切换；“黑底白线”会自动把纸色 / 白 / 浅灰换成纯黑。

> 底板识别会处理整页底板、浅色大底板，以及带 `sheet` / `frame` / `background` / `page` 标记的对象；尺寸会按父级变换和百分比解析。同色 / 近白色 / 透明描边算底板的一部分，而你在图里画的黑色或彩色分组框、模块框会保留。

---

## 使用方法

### 1. 嘉立创EDA 扩展（推荐）

#### 获取安装包
- **嘉立创 EDA 扩展广场**：[原理图美化导出](https://jlc-ext.com/item/polioko/eda-sch-beautify)
- **GitHub Releases**：[下载 `.eext`](https://github.com/totok22/eda-sch-beautify/releases)
- **CNB 国内镜像**：[下载 `.eext`](https://cnb.cool/BITFSAE/eda-sch-beautify/-/releases)
- 或者自己构建（见下）

#### 构建打包（支持 Win11 / macOS / Linux）
```bash
# 在项目根目录下运行（需要 Node.js ≥ 20.17）：
npm run setup     # 首次：安装 extension/ 的依赖（npm ci）
npm run build     # 打包
npm run test      # 可选：跑核心算法回归测试
```
打包成功后，将在 `extension/dist/` 下生成 `eda-sch-beautify_v<版本>.eext` 安装包。也可以在 `extension/` 下运行 `./build.sh`。

> **国内镜像**：仓库代码、标签和每个正式发布的 `.eext` 会自动同步到 [CNB](https://cnb.cool/BITFSAE/eda-sch-beautify)。GitHub Actions 未跑完时，也可以在 CNB 仓库的流水线里手动触发「补做 GitHub 发布镜像」。

#### 安装与使用
1. 打开嘉立创EDA专业版（V2/V3）。
2. 打开菜单：**「高级 → 扩展管理器」**（或「设置 → 扩展 → 扩展管理器」）。
3. 点击 **「导入」**，选择打包好的 `.eext` 文件。
4. 在「已安装」列表中启用本扩展，并**勾选「显示在顶部菜单」**。
5. 打开原理图编辑器，在顶部菜单点击 **「原理图美化」** 即可打开现代化导出面板。

### 2. Python 命令行工具（`python/`）
```bash
pip install lxml
python3 python/eda_sch_beautify.py 原理图.svg 输出.svg         # 默认参数美化
python3 python/eda_sch_beautify.py -h                         # 查看全部 CLI 参数
python3 python/eda_sch_beautify.py 原理图.svg 输出.svg --color-theme black-on-white   # 单色（白底黑线）
python3 python/render.py 输出.svg 输出.png 3000                # 用 Chrome 渲染 PNG 预览
```

常用参数：`--r` 半径、`--close shrink|merge`、`--hop horizontal|vertical|auto`、`--junction-color wire|keep`、`--keep-end-markers`、`--font-mode split|element`、`--keep-font`、`--exclude-rect x,y,w,h`、`--axis-tol`、`--keep-background`、`--color-theme default|black-on-white|white-on-black`。命令行输出不带背景矩形，用 `white-on-black` 时请自己给图加黑色背景。

---

## 识别规则（基于嘉立创EDA专业版导出实测）
| 元素 | SVG 表示 | 处理方式 |
|---|---|---|
| 导线 | `<polyline c_partid="wire" points="…">` | 正交相交处自动生成平滑向上半圆跨线弧 |
| 节点 | 实心 `<circle r="2.5" fill:#CC0000>` | 自动提取相连导线颜色并保持一致 |
| 未连接标记 | `<circle r="1" stroke:#999999 fill:#999999B3>` | 智能识别并安全清除 |
| 引脚端点 | 空心 `<ellipse>`，引脚 `c_partid="part_pin"` | 跨线弧自动避让，不产生虚假跨越 |
| 中文字体 | 含有 CJK 汉字的 `<text>` / `<tspan>` | 自动设定为宋体（SimSun），西文保留衬线体 |

---

## 已知限制
- 只处理水平/竖直导线（轻微偏斜在 `--axis-tol` 内按正交处理），斜线忽略
- 文字避让的文字范围按字号估算
- “选中图元”区域依赖 EDA 图元 ID 与 SVG 元素 ID 对应；对不上时退回 API 坐标换算（y 轴翻转假设，未校准），可改用手动框选

## English summary
**eda-sch-beautify** post-processes schematic SVG exported from JLCEDA / EasyEDA Pro: KiCad-style semicircle hop-overs at unconnected wire crossings, junction dots recolored to the wire color, gray "unconnected" markers removed, CJK text in SimSun while Latin stays Times New Roman, the sheet background stripped, optional monochrome output (black on white / white on black), and PNG export at 1x/2x/4x/6x with transparent / white / KiCad paper (#F5F4EF) / black background and region export (selection or drag-box). Available as an EasyEDA Pro extension (`extension/`; `npm run setup && npm run build`, then import the `.eext` via the Extension Manager) and as a Python CLI (`python/eda_sch_beautify.py`). The schematic itself is never modified. License: MIT (SDK-derived scaffolding under Apache-2.0, see NOTICE).

---

## 许可协议
MIT License.
