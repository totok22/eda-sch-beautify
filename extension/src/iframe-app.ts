/** 原理图美化导出面板（运行在扩展 IFrame 中，拥有完整 DOM + Canvas） */
import { applyBackground, bboxForIds, cropSvg, defaultOptions, type HopoverOptions, processSvg, type Rect } from './sch-beautify-core';

declare const eda: any;
const E: any = (typeof eda !== 'undefined') ? eda : (window.parent as any)?.eda;
const $ = (id: string) => document.getElementById(id) as any;

interface Settings { radius: number; scale: number; bg: 'transparent' | 'white' | 'paper'; region: 'page' | 'selection' | 'manual'; margin: number; junctionColor: boolean; removeMarkers: boolean; font: boolean; close: 'shrink' | 'merge'; exportTheme: 'Default' | 'Black on White' | 'White on Black' }
const DEF: Settings = { radius: 0, scale: 4, bg: 'paper', region: 'page', margin: 10, junctionColor: true, removeMarkers: true, font: true, close: 'shrink', exportTheme: 'Default' };
const BG: Record<string, string | null> = { transparent: null, white: '#FFFFFF', paper: '#F5F4EF' }; // KiCad 默认原理图背景 245,244,239

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
	return { r: S.radius > 0 ? S.radius : undefined, close: S.close, junctionColor: S.junctionColor ? 'wire' : 'keep', removeEndMarkers: S.removeMarkers, font: S.font ? defaultOptions.font : null, fontMode: 'split' };
}
function region(): Rect | null { return S.region === 'manual' ? manual : S.region === 'selection' ? selRect : null; }
function finalSvg(): string {
	const r = region();
	const cropped = r ? cropSvg(outSvg, r, S.region === 'manual' ? 0 : S.margin) : outSvg;
	return applyBackground(cropped, BG[S.bg]);
}

// ---------- 预览：缩放 / 平移 ----------
let zoom = 1; let panX = 0; let panY = 0; let lastSrc = ''; let fitted = false;
const baseWidth = (svg: string) => Number.parseFloat(svg.match(/<svg\b[^>]*\swidth="([\d.]+)/)?.[1] || '') || viewBox(svg)[2];
function applyView() {
	$('layer').style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
	$('zoomLabel').textContent = `${Math.round(zoom * 100)}%`;
}
function fit() {
	const w = $('wrap'); const vb = viewBox(outSvg); const bw = baseWidth(outSvg); const bh = bw * vb[3] / vb[2];
	zoom = Math.min(w.clientWidth / bw, w.clientHeight / bh) * 0.98; panX = (w.clientWidth - bw * zoom) / 2; panY = (w.clientHeight - bh * zoom) / 2; applyView();
}
function zoomAt(f: number, cx?: number, cy?: number) {
	const w = $('wrap'); cx ??= w.clientWidth / 2; cy ??= w.clientHeight / 2;
	const nz = Math.min(40, Math.max(0.02, zoom * f)); panX = cx - (cx - panX) * nz / zoom; panY = cy - (cy - panY) * nz / zoom; zoom = nz; applyView();
}
function drawPreview() {
	const img = $('preview'); const bw = baseWidth(outSvg); const vb = viewBox(outSvg);
	const previewSvg = applyBackground(outSvg, BG[S.bg]);
	if (lastSrc !== previewSvg) { img.src = toDataUri(previewSvg); lastSrc = previewSvg; }
	img.style.background = BG[S.bg] ?? 'transparent';
	img.style.width = `${bw}px`; img.style.height = `${bw * vb[3] / vb[2]}px`;
	if (!fitted) { fitted = true; requestAnimationFrame(fit); }
	const box = $('selbox'); const r = region();
	if (!r) { box.style.display = 'none'; return; }
	const k = bw / vb[2];
	Object.assign(box.style, { display: 'block', left: `${(r[0] - vb[0]) * k}px`, top: `${(r[1] - vb[1]) * k}px`, width: `${r[2] * k}px`, height: `${r[3] * k}px`, borderWidth: `${2 / zoom}px` });
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
	drawPreview();
}

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
		S.region = 'selection'; writeForm(); drawPreview();
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
	let sized = svg.replace(/<svg\b[^>]*>/, (tag) => {
		let t = tag.replace(/\s(width|height|preserveAspectRatio)="[^"]*"/g, '');
		t = t.replace(/^<svg/, `<svg width="${W}" height="${H}" preserveAspectRatio="none"`);
		return t;
	});
	if (!/<svg\b[^>]*viewBox=/.test(sized)) sized = sized.replace(/^<svg/, `<svg viewBox="${vb.join(' ')}"`);
	const img = new Image();
	await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('SVG 图片加载失败')); img.src = toDataUri(sized); });
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
		const r = $('preview').getBoundingClientRect(); const vb = viewBox(outSvg); const k = vb[2] / r.width;
		return [vb[0] + (ev.clientX - r.left) * k, vb[1] + (ev.clientY - r.top) * k];
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
		if (pan) { panX = pan[2] + ev.clientX - pan[0]; panY = pan[3] + ev.clientY - pan[1]; applyView(); return; }
		if (!start) return; const p = toSvg(ev);
		manual = [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.abs(p[0] - start[0]), Math.abs(p[1] - start[1])]; drawPreview();
	});
	window.addEventListener('mouseup', () => {
		if (pan) { pan = null; wrap.style.cursor = space ? 'grab' : ''; }
		if (start) { start = null; if (manual && manual[2] < 1) manual = null; drawPreview(); }
	});
	wrap.addEventListener('wheel', (ev: WheelEvent) => { ev.preventDefault(); const r = wrap.getBoundingClientRect(); zoomAt(ev.deltaY < 0 ? 1.2 : 1 / 1.2, ev.clientX - r.left, ev.clientY - r.top); }, { passive: false });
	$('zIn').onclick = () => zoomAt(1.25); $('zOut').onclick = () => zoomAt(0.8); $('zFit').onclick = () => fit();
	$('z100').onclick = () => { const w = $('wrap'); const c = [(w.clientWidth / 2 - panX) / zoom, (w.clientHeight / 2 - panY) / zoom]; zoom = 1; panX = w.clientWidth / 2 - c[0]; panY = w.clientHeight / 2 - c[1]; applyView(); };
	window.addEventListener('resize', () => fit());
}

// ---------- 主题 ----------
async function applyTheme() {
	let t: string | undefined;
	try { t = await E?.sys_Window?.getCurrentTheme?.(); }
	catch {}
	if (t !== 'dark' && t !== 'light') t = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	document.documentElement.dataset.theme = t;
}

async function main() {
	await applyTheme(); setInterval(applyTheme, 3000);
	loadSettings(); writeForm(); setupDrag();
	$('etheme').addEventListener('change', async () => { readForm(); await saveSettings(); try { srcSvg = await exportSvgFromEda(); fitted = false; await refresh(); } catch (e) { log((e as Error).message, true); } });
	for (const id of ['radius', 'scale', 'bg', 'margin', 'jc', 'rm', 'font', 'close']) $(id).addEventListener('change', () => refresh());
	document.querySelectorAll('input[name=region]').forEach(el => el.addEventListener('change', () => { readForm(); saveSettings(); drawPreview(); }));
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
