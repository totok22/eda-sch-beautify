/**
 * 跨线弧 SVG 导出扩展 — 入口
 * 菜单（原理图编辑器 → 跨线弧）：
 *   导出跨线弧 SVG      → 导出当前原理图图页 SVG，加跨线弧/节点改色/删除未连接标记/中文改宋体后保存
 *   导出跨线弧 SVG + PNG → 同上，并尝试用画布渲染 PNG（依赖运行环境支持 Image/Canvas）
 *   设置跨线弧半径…     → 设置半径（0 = 自动：3×线宽）
 */
import extensionConfig from '../extension.json' with { type: 'json' };
import { buildFileName, currentPageName } from './file-name';
import { defaultOptions, type HopoverOptions, processSvg } from './sch-beautify-core';

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {}

function loadOptions(): Partial<HopoverOptions> {
	try {
		const cfg = eda.sys_Storage.getExtensionAllUserConfigs() || {};
		const h = cfg.hopover || {};
		const r = Number(h.radius ?? cfg.radius);
		return {
			r: Number.isFinite(r) && r > 0 ? r : undefined,
			close: h.close === 'merge' ? 'merge' : 'shrink',
			junctionColor: h.junctionColor === false ? 'keep' : 'wire',
			removeEndMarkers: h.removeMarkers !== false,
			font: h.font === false ? null : defaultOptions.font,
		};
	}
	catch { return {}; }
}

/** 打开导出面板（IFrame：完整 DOM/Canvas，负责 PNG、区域、设置） */
export async function openPanel(): Promise<void> {
	try {
		const ok = await eda.sys_IFrame.openIFrame('/iframe/panel.html', 760, 720, 'sch-beautify-panel', { title: '原理图美化导出', maximizeButton: true, minimizeButton: true });
		if (!ok) toast('打开导出面板失败', 'error');
	}
	catch (e) { toast(`打开导出面板失败：${(e as Error).message}`, 'error'); }
}

async function exportPageSvg(): Promise<File | undefined> {
	let f: File | undefined;
	try {
		f = await eda.sch_ManufactureData.getExportDocumentFile('schematic', 'SVG' as any, { theme: 'Default', size: 'Original Size' }, 'Current Schematic Page');
	}
	catch (e) { console.warn('getExportDocumentFile failed', e); }
	if (!f) f = await eda.sch_ManufactureData.getSvgFile('schematic');
	return f;
}

function toast(msg: string, type: 'success' | 'error' | 'warn' | 'info' = 'info') {
	try { eda.sys_ToastMessage.showMessage(msg, type as any, 6); }
	catch { eda.sys_Dialog.showInformationMessage(msg, '跨线弧'); }
}

async function run() {
	try {
		const f = await exportPageSvg();
		if (!f) { toast('导出 SVG 失败：请先打开一个原理图图页', 'error'); return; }
		if (/\.zip$/i.test(f.name || '')) { toast('导出结果是压缩包（多图页），请在单个图页中使用', 'warn'); return; }
		const name = await currentPageName(eda, f.name);
		const src = await f.text();
		const { svg, stats } = processSvg(src, loadOptions());
		await eda.sys_FileSystem.saveFile(new Blob([svg], { type: 'image/svg+xml' }), buildFileName(name, 'svg'));
		eda.sys_Dialog.showInformationMessage(
			`交叉 ${stats.crossings} 处，画弧 ${stats.arcs} 个（合并 ${stats.merged}），跳过 ${stats.skipped.length}\n`
			+ `删除未连接标记 ${stats.markersRemoved} 个，节点改色 ${stats.dotsRecolored} 个（颜色冲突 ${stats.colorConflicts.length}）\n`
			+ `中文文字改宋体 ${stats.fontChanged} 处`,
			'原理图美化导出完成',
		);
	}
	catch (e) {
		toast(`原理图美化导出出错：${(e as Error).message}`, 'error');
	}
}

export async function exportHopSvg(): Promise<void> { await run(); }
export async function exportHopSvgPng(): Promise<void> { await openPanel(); }

export async function settings(): Promise<void> { await openPanel(); }

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		`原理图美化导出 v${extensionConfig.version}\n默认：水平线向上跨线弧、节点跟随导线颜色、删除灰色未连接标记、中文文字改宋体。\n默认参数：${JSON.stringify({ close: defaultOptions.close, minR: defaultOptions.minR })}`,
		'关于',
	);
}
