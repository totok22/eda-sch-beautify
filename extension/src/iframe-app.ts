/** 原理图美化导出面板（运行在扩展 IFrame 中，拥有完整 DOM + Canvas） */
import { applyBackground, bboxForIds, cropSvg, defaultOptions, type HopoverOptions, processSvg, type Rect } from './sch-beautify-core';

declare const eda: any;
const E: any = (typeof eda !== 'undefined') ? eda : (window.parent as any)?.eda;
const $ = (id: string) => document.getElementById(id) as any;

interface Settings { radius: number; scale: number; bg: 'transparent' | 'white' | 'paper' | 'black'; region: 'page' | 'selection' | 'manual'; margin: number; junctionColor: boolean; removeMarkers: boolean; font: boolean; close: 'shrink' | 'merge'; exportTheme: 'Default' | 'Black on White' | 'White on Black' }
const DEF: Settings = { radius: 0, scale: 4, bg: 'paper', region: 'page', margin: 10, junctionColor: true, removeMarkers: true, font: true, close: 'shrink', exportTheme: 'Default' };
const BG: Record<string, string | null> = { transparent: null, white: '#FFFFFF', paper: '#F5F4EF', black: '#000000' }; // KiCad 默认原理图背景 245,244,239

let S: Settings = { ...DEF }; let srcSvg = ''; let outSvg = ''; let manual: Rect | null = null; let selRect: Rect | null = null; let fileBase = 'schematic';

function log(msg: string, err = false, busy = false) {
	const el = $('status'); if (el) { el.textContent = msg; el.style.color = err ? 'var(--err)' : 'var(--fg)'; }
	const dot = $('statusDot'); if (dot) { dot.className = `dot${err ? ' err' : busy ? ' busy' : ''}`; }
}
function loadSettings() {
	try { const c = E?.sys_Storage?.getExtensionAllUserConfigs?.(); if (c && c.hopover) S = { ...DEF, ...c.hopover }; }
	catch {}
	try { const l = localStorage.getItem('sch-beautify-settings'); if (l && !E?.sys_Storage) S = { ...DEF, ...JSON.parse(l) }; }
	catch {}
}
async function saveSettings() {
	try { await E?.sys_Storage?.setExtensionAllUserConfigs?.({ hopover: S, radius: S.radius }); }
	catch {}
	try { localStorage.setItem('sch-beautify-settings', JSON.stringify(S)); }
	catch {}
}
function readForm() {
	S.radius = Number($('radius').value) || 0; S.scale = Number($('scale').value) || 4; S.bg = $('bg').value; S.margin = Number($('margin').value) || 0;
	S.region = (document.querySelector('input[name=region]:checked') as any)?.value || 'page';
	S.junctionColor = $('jc').checked; S.removeMarkers = $('rm').checked; S.font = $('font').checked; S.close = $('close').value; S.exportTheme = $('etheme').value;
}
function writeForm() {
	$('radius').value = S.radius; $('scale').value = S.scale; $('bg').value = S.bg; $('margin').value = S.margin;
	(document.querySelector(`input[name=region][value=${S.region}]`) as any).checked = true;
	$('jc').checked = S.junctionColor; $('rm').checked = S.removeMarkers; $('font').checked = S.font; $('close').value = S.close; $('etheme').value = S.exportTheme;
}
const toDataUri = (svg: string) => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
const viewBox = (svg: string): Rect => (svg.match(/viewBox="([^"]+)"/)?.[1] || '0 0 100 100').split(/[\s,]+/).map(Number) as Rect;

function options(): Partial<HopoverOptions> {
	return { r: S.radius > 0 ? S.radius : undefined, close: S.close, junctionColor: S.junctionColor ? 'wire' : 'keep', removeEndMarkers: S.removeMarkers, font: S.font ? defaultOptions.font : null, fontMode: 'split', colorTheme: S.exportTheme };
}
function region(): Rect | null { return S.region === 'manual' ? manual : S.region === 'selection' ? selRect : null; }
function finalSvg(): string {
	const r = region();
	const cropped = r ? cropSvg(outSvg, r, S.region === 'manual' ? 0 : S.margin) : outSvg;
	return applyBackground(cropped, BG[S.bg]);
}

// ---------- 预览：栅格化底图 + 可视区高清细节层 ----------
// 预览不直接显示矢量 SVG：缩放/平移时浏览器要反复重光栅化整页 SVG（大图纸会卡）。
// 这里把 SVG 栅格化成位图放进同一个 #layer，缩放/平移只改这一层的 transform（GPU 合成，不重绘）：
//   #preview   全页底图，最长边 ≤ 2048，随时可用；
//   #previewHi 可视区细节层，操作停下后按“当前缩放 × DPR（≤2）”重新栅格化，放大后依然清晰。
const BASE_MAX = 2048; const HI_MAX_EDGE = 8192; const HI_MAX_PIXELS = 16e6; const SETTLE_MS = 140;
const dprCap = () => Math.min(window.devicePixelRatio || 1, 2);
let zoom = 1; let panX = 0; let panY = 0; let fitted = false; let userView = false; let lastLabel = '';
let G = { vb: [0, 0, 100, 100] as Rect, bw: 100, bh: 100, k: 1 }; // bw/bh：页面 CSS 像素；k：每 CSS 像素对应的 SVG 单位
let pvSvg = ''; let ver = 0; let baseScale = 1; let baseTok = 0; let hiTok = 0; let hiTimer = 0; let hiShown = false;
let hi: { ver: number; x: number; y: number; w: number; h: number; scale: number } | null = null;
const baseWidth = (svg: string) => Number.parseFloat(svg.match(/<svg\b[^>]*\swidth="([\d.]+)/)?.[1] || '') || viewBox(svg)[2];

function setGeom(svg: string) { const vb = viewBox(svg); const bw = baseWidth(svg); G = { vb, bw, bh: bw * vb[3] / vb[2], k: vb[2] / bw }; }
/** 把根 <svg> 改成目标像素尺寸 + 指定 viewBox（矢量直接按目标分辨率栅格化；viewBox 可以只取一块区域） */
function retarget(svg: string, W: number, H: number, vb: Rect): string {
	return svg.replace(/<svg\b[^>]*>/, tag => tag.replace(/\s(width|height|preserveAspectRatio|viewBox)="[^"]*"/g, '').replace(/^<svg/, `<svg width="${W}" height="${H}" viewBox="${vb.join(' ')}" preserveAspectRatio="none"`));
}
function loadSvgImage(svg: string): Promise<HTMLImageElement> {
	const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('SVG 图片加载失败')); img.src = src; });
	// 优先用 Blob URL（省掉 base64）；宿主没有 createObjectURL 或加载失败时退回 data URI
	if (typeof URL !== 'undefined' && URL.createObjectURL) {
		const u = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
		return load(u).finally(() => URL.revokeObjectURL(u)).catch(() => load(toDataUri(svg)));
	}
	return load(toDataUri(svg));
}
/** SVG → 画布；加载完才改画布尺寸，加载期间旧位图继续显示。valid() 为 false 表示结果已过期，不绘制 */
async function rasterTo(cv: HTMLCanvasElement, svg: string, W: number, H: number, vb: Rect, valid: () => boolean = () => true): Promise<boolean> {
	const img = await loadSvgImage(retarget(svg, W, H, vb));
	if (!valid()) return false;
	cv.width = W; cv.height = H;
	const ctx = cv.getContext('2d'); if (!ctx) throw new Error('无法创建画布');
	ctx.drawImage(img, 0, 0, W, H);
	return true;
}

/** 可视区域（页面 CSS 像素坐标，已与页面求交）；页面完全在视口外时返回 null */
function visiblePage() {
	const w = $('wrap'); const x0 = -panX / zoom; const y0 = -panY / zoom;
	const x = Math.max(0, x0); const y = Math.max(0, y0); const r = Math.min(G.bw, x0 + w.clientWidth / zoom); const b = Math.min(G.bh, y0 + w.clientHeight / zoom);
	return r > x && b > y ? { x, y, w: r - x, h: b - y } : null;
}
const covers = (h: { x: number; y: number; w: number; h: number }, v: { x: number; y: number; w: number; h: number }) => v.x >= h.x - 0.5 && v.y >= h.y - 0.5 && v.x + v.w <= h.x + h.w + 0.5 && v.y + v.h <= h.y + h.h + 0.5;
/** 细节层覆盖整个可视区时只显示细节层，否则退回底图（两层从不同时可见，透明背景下不会叠色） */
function syncLayers() {
	const v = visiblePage(); const on = !!(hi && hi.ver === ver && v && covers(hi, v));
	if (on === hiShown) return;
	hiShown = on; $('previewHi').style.visibility = on ? 'visible' : 'hidden'; $('preview').style.visibility = on ? 'hidden' : 'visible';
}
async function renderBase() {
	const tok = ++baseTok; const my = ver; const cv = $('preview');
	const s = Math.min(BASE_MAX, Math.ceil(Math.max(G.bw, G.bh) * dprCap())) / Math.max(G.bw, G.bh);
	const W = Math.max(1, Math.round(G.bw * s)); const H = Math.max(1, Math.round(G.bh * s));
	try { if (!(await rasterTo(cv, pvSvg, W, H, G.vb, () => tok === baseTok && my === ver))) return; }
	catch (e) { log(`预览渲染失败：${(e as Error).message}`, true); return; }
	baseScale = W / G.bw; scheduleDetail(0);
}
async function renderDetail() {
	if (!pvSvg) return;
	const v = visiblePage(); if (!v) return;
	const need = zoom * dprCap(); // 每个页面 CSS 像素需要的位图像素
	if (need <= baseScale * 1.05) { if (hi) { hi = null; syncLayers(); } return; } // 底图已经够清晰
	if (hi && hi.ver === ver && covers(hi, v) && hi.scale >= need * 0.85 && hi.scale <= need * 2) return; // 现有细节层还能用
	let x = 0; let y = 0; let r = 0; let b = 0; let W = 0; let H = 0;
	for (const m of [0.3, 0.1, 0]) { // 可视区四周外扩一圈，平移时不会立刻露底；超出位图上限就收窄外扩
		x = Math.max(0, v.x - v.w * m); y = Math.max(0, v.y - v.h * m); r = Math.min(G.bw, v.x + v.w * (1 + m)); b = Math.min(G.bh, v.y + v.h * (1 + m));
		W = (r - x) * need; H = (b - y) * need;
		if (Math.max(W, H) <= HI_MAX_EDGE && W * H <= HI_MAX_PIXELS) break;
	}
	const shrink = Math.min(1, HI_MAX_EDGE / Math.max(W, H), Math.sqrt(HI_MAX_PIXELS / (W * H)));
	W = Math.max(1, Math.round(W * shrink)); H = Math.max(1, Math.round(H * shrink));
	const tok = ++hiTok; const my = ver; const cv = $('previewHi');
	const vb: Rect = [G.vb[0] + x * G.k, G.vb[1] + y * G.k, (r - x) * G.k, (b - y) * G.k];
	try { if (!(await rasterTo(cv, pvSvg, W, H, vb, () => tok === hiTok && my === ver))) return; }
	catch (e) { console.warn('detail layer failed', e); return; }
	Object.assign(cv.style, { left: `${x}px`, top: `${y}px`, width: `${r - x}px`, height: `${b - y}px` });
	hi = { ver: my, x, y, w: r - x, h: b - y, scale: W / (r - x) };
	syncLayers();
}
function scheduleDetail(delay = SETTLE_MS) { clearTimeout(hiTimer); hiTimer = window.setTimeout(renderDetail, delay); }

/** 内容（美化结果 / 背景）变了：重建预览 SVG，底图重新栅格化，细节层作废 */
function renderPreview() {
	setGeom(outSvg); pvSvg = applyBackground(outSvg, BG[S.bg]); ver++; hi = null; syncLayers();
	Object.assign($('preview').style, { width: `${G.bw}px`, height: `${G.bh}px` });
	if (!fitted) { fitted = true; requestAnimationFrame(fit); }
	renderBase(); updateSelBox();
}

// 视图（缩放/平移）只写一层 transform，且每帧最多写一次
let viewRaf = 0;
function applyView() { if (!viewRaf) viewRaf = requestAnimationFrame(() => { viewRaf = 0; paintView(); }); }
function paintView() {
	$('layer').style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
	const label = `${Math.round(zoom * 100)}%`; if (label !== lastLabel) { lastLabel = label; $('zoomLabel').textContent = label; }
	updateSelBox(); syncLayers(); scheduleDetail();
}
function fit() {
	const w = $('wrap'); const tb = document.querySelector('.floating-toolbar') as HTMLElement | null;
	const top = tb ? tb.offsetTop + tb.offsetHeight + 8 : 0; // 悬浮工具条盖在画布顶部，适应时避开它
	const cw = w.clientWidth; const ch = Math.max(1, w.clientHeight - top);
	zoom = Math.min(cw / G.bw, ch / G.bh) * 0.98; panX = (cw - G.bw * zoom) / 2; panY = top + (ch - G.bh * zoom) / 2; userView = false; applyView();
}
function zoomAt(f: number, cx?: number, cy?: number) {
	const w = $('wrap'); cx ??= w.clientWidth / 2; cy ??= w.clientHeight / 2;
	const nz = Math.min(40, Math.max(0.02, zoom * f)); panX = cx - (cx - panX) * nz / zoom; panY = cy - (cy - panY) * nz / zoom; zoom = nz; userView = true; applyView();
}
/** 导出区域框：画在 #layer 外（屏幕坐标），边框恒为 2px，不随缩放变糊 */
function updateSelBox() {
	const box = $('selbox'); let r = region();
	if (!r) { box.style.display = 'none'; return; }
	if (S.region === 'selection') r = [r[0] - S.margin, r[1] - S.margin, r[2] + 2 * S.margin, r[3] + 2 * S.margin]; // 与 cropSvg 的边距一致
	const f = zoom / G.k;
	Object.assign(box.style, { display: 'block', left: `${panX + (r[0] - G.vb[0]) * f}px`, top: `${panY + (r[1] - G.vb[1]) * f}px`, width: `${r[2] * f}px`, height: `${r[3] * f}px` });
}

async function exportSvgFromEda(): Promise<string> {
	if (!E) throw new Error('IFrame 中拿不到 eda 对象');
	let f: File | undefined;
	try { f = await E.sch_ManufactureData.getExportDocumentFile('schematic', 'SVG', { theme: S.exportTheme, size: 'Original Size' }, 'Current Schematic Page'); }
	catch (e) { console.warn(e); }
	if (!f) f = await E.sch_ManufactureData.getSvgFile('schematic');
	if (!f) throw new Error('导出 SVG 失败：请先打开一个原理图图页');
	if (/\.zip$/i.test(f.name || '')) throw new Error('导出结果是压缩包（多图页），请在单个图页中使用');
	fileBase = (f.name || 'schematic.svg').replace(/\.svg$/i, '');
	return await f.text();
}

async function refresh() {
	readForm(); await saveSettings();
	const res = processSvg(srcSvg, options()); outSvg = res.svg; const s = res.stats;
	$('stats').textContent = `交叉 ${s.crossings} · 画弧 ${s.arcs}${s.merged ? ` (合并 ${s.merged})` : ''} · 清理未连接标记 ${s.markersRemoved} · 节点改色 ${s.dotsRecolored} · 中文宋体 ${s.fontChanged} 处${s.backgroundRemoved ? ` · 清除原底板 ${s.backgroundRemoved}` : ''}`;
	renderPreview();
}
/** 只改了背景底色：不用重跑美化算法 */
function restyle() { readForm(); saveSettings(); if (outSvg) renderPreview(); }

async function useSelection() {
	selRect = null;
	try {
		const ids: string[] = await E.sch_SelectControl.getAllSelectedPrimitives_PrimitiveId();
		if (!ids?.length) { log('没有选中图元：请先在原理图里框选要导出的部分，再点“读取选中”', true); return; }
		const hit = bboxForIds(outSvg, ids);
		if (hit) { selRect = hit.box; log(`已按选中的 ${ids.length} 个图元确定区域（SVG 中匹配到 ${hit.matched} 个元素）`); }
		else {
			const b = await E.sch_Primitive.getPrimitivesBBox(ids);
			if (!b) { log('选中图元无法换算区域，请改用“手动框选”', true); return; }
			selRect = [b.minX, -b.maxY, b.maxX - b.minX, b.maxY - b.minY]; // 假设 SVG y = -API y（未校准）
			log('SVG 中找不到选中图元的 ID，已按 API 坐标换算区域（假设 y 轴翻转，未校准，请看预览框是否正确）');
		}
		S.region = 'selection'; writeForm(); updateSelBox();
	}
	catch (e) { log(`读取选中失败：${(e as Error).message}`, true); }
}

async function save(blob: Blob, name: string) {
	try { if (E?.sys_FileSystem?.saveFile) { await E.sys_FileSystem.saveFile(blob, name); return; } }
	catch (e) { console.warn('saveFile failed, fallback to <a download>', e); }
	const a = document.createElement('a'); a.download = name;
	a.href = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(blob) : await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.readAsDataURL(blob); });
	document.body.appendChild(a); a.click(); a.remove();
}

async function renderPng(svg: string): Promise<Blob> {
	const vb = viewBox(svg);
	const baseW = Number.parseFloat(svg.match(/<svg\b[^>]*\swidth="([\d.]+)/)?.[1] || '') || vb[2];
	let W = Math.round(baseW * S.scale); let H = Math.round(W * vb[3] / vb[2]);
	const k = Math.min(1, 16000 / Math.max(W, H), Math.sqrt(200e6 / (W * H))); // 浏览器画布上限保护
	if (k < 1) { W = Math.floor(W * k); H = Math.floor(H * k); }
	// 把 SVG 自身尺寸设成目标像素尺寸（矢量直接按目标分辨率栅格化），并拉伸到整张画布避免留边
	const img = await loadSvgImage(retarget(svg, W, H, vb));
	const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
	const ctx = cv.getContext('2d'); if (!ctx) throw new Error('无法创建画布');
	ctx.clearRect(0, 0, W, H);
	const bg = BG[S.bg]; if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
	ctx.drawImage(img, 0, 0, W, H);
	const blob: Blob | null = await new Promise(r => cv.toBlob(r, 'image/png'));
	if (blob) return blob;
	const bin = atob(cv.toDataURL('image/png').split(',')[1]); const u8 = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
	return new Blob([u8], { type: 'image/png' });
}

function setupDrag() {
	const wrap = $('wrap'); let start: [number, number] | null = null; let pan: [number, number, number, number] | null = null; let space = false;
	const toSvg = (ev: MouseEvent): [number, number] => {
		const r = wrap.getBoundingClientRect();
		return [G.vb[0] + (ev.clientX - r.left - panX) / zoom * G.k, G.vb[1] + (ev.clientY - r.top - panY) / zoom * G.k];
	};
	const panMode = (ev: MouseEvent) => space || ev.button === 1 || $('mode').value === 'pan' || !$('rManual').checked;
	window.addEventListener('keydown', (e) => { if (e.code === 'Space' && (e.target as any)?.tagName !== 'INPUT') { space = true; wrap.style.cursor = 'grab'; e.preventDefault(); } });
	window.addEventListener('keyup', (e) => { if (e.code === 'Space') { space = false; wrap.style.cursor = ''; } });
	wrap.addEventListener('mousedown', (ev: MouseEvent) => {
		ev.preventDefault();
		if (panMode(ev)) { pan = [ev.clientX, ev.clientY, panX, panY]; wrap.style.cursor = 'grabbing'; }
		else start = toSvg(ev);
	});
	window.addEventListener('mousemove', (ev: MouseEvent) => {
		if (pan) { panX = pan[2] + ev.clientX - pan[0]; panY = pan[3] + ev.clientY - pan[1]; userView = true; applyView(); return; }
		if (!start) return; const p = toSvg(ev);
		manual = [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.abs(p[0] - start[0]), Math.abs(p[1] - start[1])]; updateSelBox();
	});
	window.addEventListener('mouseup', () => {
		if (pan) { pan = null; wrap.style.cursor = space ? 'grab' : ''; }
		if (start) { start = null; if (manual && manual[2] < 1) manual = null; updateSelBox(); }
	});
	wrap.addEventListener('wheel', (ev: WheelEvent) => {
		ev.preventDefault(); // 指数缩放：触控板的连续小增量不会一下放大很多；ctrl+滚轮是触控板捏合
		const f = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1) * (ev.ctrlKey ? 0.012 : 0.0018));
		const r = wrap.getBoundingClientRect(); zoomAt(Math.min(2, Math.max(0.5, f)), ev.clientX - r.left, ev.clientY - r.top);
	}, { passive: false });
	$('zIn').onclick = () => zoomAt(1.25); $('zOut').onclick = () => zoomAt(0.8); $('zFit').onclick = () => fit();
	$('z100').onclick = () => { const w = $('wrap'); const c = [(w.clientWidth / 2 - panX) / zoom, (w.clientHeight / 2 - panY) / zoom]; zoom = 1; panX = w.clientWidth / 2 - c[0]; panY = w.clientHeight / 2 - c[1]; userView = true; applyView(); };
	window.addEventListener('resize', () => { if (userView) applyView(); else fit(); }); // 用户手动缩放/平移过就保留视图，只补清晰度
}

// ---------- 主题 ----------
async function applyTheme() {
	let t: string | undefined;
	try { t = await E?.sys_Window?.getCurrentTheme?.(); }
	catch {}
	if (t !== 'dark' && t !== 'light') t = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	if (document.documentElement.dataset.theme !== t) document.documentElement.dataset.theme = t;
}
/** 不轮询：系统主题变化、面板重新获得焦点 / 可见时各检查一次 */
function watchTheme() {
	try { window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', applyTheme); }
	catch {}
	window.addEventListener('focus', applyTheme);
	document.addEventListener('visibilitychange', () => { if (!document.hidden) applyTheme(); });
}
/** 黑底白线配黑色背景才看得见白线；离开黑底白线时把黑色背景换回纸色 */
function syncBgToTheme() {
	if (S.exportTheme === 'White on Black' && (S.bg === 'paper' || S.bg === 'white')) S.bg = 'black';
	else if (S.exportTheme !== 'White on Black' && S.bg === 'black') S.bg = 'paper';
	writeForm();
}

async function main() {
	await applyTheme(); watchTheme();
	loadSettings(); writeForm(); setupDrag();
	$('etheme').addEventListener('change', async () => { readForm(); syncBgToTheme(); await saveSettings(); try { srcSvg = await exportSvgFromEda(); fitted = false; await refresh(); } catch (e) { log((e as Error).message, true); } });
	for (const id of ['radius', 'jc', 'rm', 'font', 'close']) $(id).addEventListener('change', () => refresh()); // 影响美化结果，需要重跑算法
	$('bg').addEventListener('change', restyle); // 只影响背景
	for (const id of ['scale', 'margin']) $(id).addEventListener('change', () => { readForm(); saveSettings(); updateSelBox(); }); // 只影响导出
	document.querySelectorAll('input[name=region]').forEach(el => el.addEventListener('change', () => { readForm(); saveSettings(); updateSelBox(); }));
	$('btnSel').onclick = () => useSelection();
	$('btnReload').onclick = async () => { try { log('正在重新读取原理图…', false, true); srcSvg = await exportSvgFromEda(); await refresh(); log('已重新读取当前图页'); } catch (e) { log((e as Error).message, true); } };
	$('btnSvg').onclick = async () => { try { log('正在生成并保存 SVG…', false, true); await save(new Blob([finalSvg()], { type: 'image/svg+xml' }), `${fileBase}_beautify.svg`); log('SVG 已保存'); } catch (e) { log(`保存 SVG 失败：${(e as Error).message}`, true); } };
	$('btnPng').onclick = async () => {
		try { log('正在渲染 PNG 图片…', false, true); const b = await renderPng(finalSvg()); await save(b, `${fileBase}_beautify@${S.scale}x.png`); log(`PNG 已保存（${S.scale}x，背景：${S.bg}）`); }
		catch (e) { log(`PNG 渲染失败：${(e as Error).message}`, true); }
	};
	if (!E) { log('IFrame 中拿不到 eda 对象，无法读取原理图（此运行环境不支持）', true); return; }
	try { log('正在读取图页…', false, true); srcSvg = await exportSvgFromEda(); await refresh(); log('就绪：可直接导出，或选择区域后导出'); }
	catch (e) { log((e as Error).message, true); }
}
main();
