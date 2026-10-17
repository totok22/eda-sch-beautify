/** 核心算法回归测试：`npm run test`（需要先 npm install）。用 examples/example.svg + 合成用例，不依赖本机私有文件 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import { buildFileName, currentPageName, formatStamp, sanitizeFileName } from '../src/file-name.ts';
import { applyBackground, applyColorTheme, cropSvg, processSvg, stripBackground } from '../src/sch-beautify-core.ts';

const example = fs.readFileSync(new URL('../../examples/example.svg', import.meta.url), 'utf8');
const page = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700" viewBox="0 0 1000 700"><defs></defs>${inner}<polyline c_partid="wire" points="10,10 100,10" style="stroke:#008800;stroke-width:1"/></svg>`;
const rect = (x: number, y: number, w: number | string, h: number | string, style: string) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" style="${style}"/>`;
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test('stripBackground：整页底板（任意颜色）、无描边的浅色大底板会删', () => {
	assert.equal(stripBackground(page(rect(0, 0, 1000, 700, 'fill:#fff'))).removed, 1);
	assert.equal(stripBackground(page(rect(0, 0, 1000, 700, 'fill:#000'))).removed, 1);
	assert.equal(stripBackground(page(rect(50, 50, 800, 500, 'fill:#fff'))).removed, 1);
});
test('stripBackground：带描边的分组框 / 模块框、小色块不能删', () => {
	assert.equal(stripBackground(page(rect(100, 100, 300, 250, 'fill:#ffffff;stroke:#000'))).removed, 0);
	assert.equal(stripBackground(page(rect(100, 100, 450, 300, 'fill:#F5F4EF;stroke:#000'))).removed, 0);
	assert.equal(stripBackground(page(rect(10, 10, 50, 20, 'fill:#fff'))).removed, 0);
});
test('stripBackground：EDA 底板带同色 / 透明描边、百分比尺寸或父级变换，也不能残留', () => {
	assert.equal(stripBackground(page(rect(0, 0, 1000, 700, 'fill:#FFFCF8;stroke:#FFFCF8'))).removed, 1);
	assert.equal(stripBackground(page(rect(0, 0, 1000, 700, 'fill:#FFFCF8;stroke:#FFFFFF;stroke-width:1'))).removed, 1);
	assert.equal(stripBackground(page(rect(0, 0, 1000, 700, 'fill:#FFFCF8;stroke:#000;stroke-opacity:0'))).removed, 1);
	assert.equal(stripBackground(page(rect(0, 0, '100%', '100%', 'fill:#FFFCF8'))).removed, 1);
	const transformed = page('<g transform="scale(2)">' + rect(0, 0, 500, 350, 'fill:#FFFCF8') + '</g>');
	assert.equal(stripBackground(transformed).removed, 1);
	assert.equal(stripBackground(page('<path d="M0 0H1000V700H0Z" fill="#FFFCF8"/>')).removed, 1);
	assert.equal(stripBackground(page('<polygon points="0,0 1000,0 1000,700 0,700" fill="#FFFCF8"/>')).removed, 1);
	assert.equal(stripBackground(page('<path d="M100 100H300V250H100Z" fill="#FFFCF8"/>')).removed, 0);
});
test('applyBackground：背景是根元素第一个子元素，可重复调用，transparent 会移除', () => {
	const a = applyBackground(page(''), '#F5F4EF');
	assert.match(a, /^<svg[^>]*><rect [^>]*fill="#F5F4EF" data-bg="1"\/>/);
	assert.equal(applyBackground(a, '#F5F4EF'), a);
	assert.equal(applyBackground(a, '#FFFFFF').match(/data-bg="1"/g)?.length, 1);
	assert.doesNotMatch(applyBackground(a, null), /data-bg/);
	const late = applyBackground('<svg viewBox="0 0 10 10"><g id="c"/><defs><mask id="m"/></defs></svg>', '#fff');
	assert.ok(late.indexOf('data-bg') < late.indexOf('<g id="c"/>'), '背景不能跟在靠后的 </defs> 之后盖住内容');
});
test('applyBackground + cropSvg：裁切后背景与新 viewBox 完全重合', () => {
	const cropped = cropSvg(processSvg(example).svg, [150, -700, 300, 200], 0);
	const vb = cropped.match(/viewBox="([^"]+)"/)![1];
	const bg = applyBackground(cropped, '#F5F4EF').match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"[^>]*data-bg/)!;
	assert.deepEqual(bg.slice(1).map(Number), vb.split(' ').map(Number));
});
test('applyColorTheme：mask / pattern / url() / none 不动，data-bg 不动，幂等', () => {
	const src = '<svg viewBox="0 0 10 10"><defs><mask id="m"><rect fill="url(#p)" stroke="#fff"/></mask></defs><path fill="url(#g)" stroke="#f00" fill-opacity="1"/><circle fill="none" stroke="#00f" style="stroke:#0f0;fill:#333"/><rect fill="#abcdef" data-bg="1"/><rect fill="#fff"/></svg>';
	for (const [theme, c] of [['Black on White', '#000000'], ['White on Black', '#FFFFFF']] as const) {
		const out = applyColorTheme(src, theme);
		assert.ok(out.includes('<mask id="m"><rect fill="url(#p)" stroke="#fff"/></mask>'));
		assert.ok(out.includes(`<path fill="url(#g)" stroke="${c}" fill-opacity="1"/>`));
		assert.ok(out.includes(`fill="none" stroke="${c}" style="stroke:${c};fill:${c}"`));
		assert.ok(out.includes('<rect fill="#abcdef" data-bg="1"/>'));
		assert.equal(applyColorTheme(out, theme), out);
	}
	assert.ok(applyColorTheme(src, 'Black on White').includes('<rect fill="#fff"/>'), '白底黑线：白色填充保留');
	assert.ok(applyColorTheme(src, 'White on Black').includes('<rect fill="#FFFFFF"/>'));
});
test('processSvg：example.svg 的统计量不变；配色只剩单色', () => {
	const r = processSvg(example);
	assert.deepEqual([r.stats.crossings, r.stats.arcs, r.stats.markersRemoved, r.stats.dotsRecolored], [24, 24, 48, 32]);
	for (const [theme, c] of [['Black on White', '#000000'], ['White on Black', '#ffffff']] as const) {
		const out = processSvg(example, { colorTheme: theme }).svg;
		const paints = new Set([...out.matchAll(/(?:stroke|fill)(?::|=")\s*(#[0-9a-f]{3,6})/gi)].map(m => m[1].toLowerCase()));
		assert.ok(paints.has(c) && !paints.has('#0000ff') && !paints.has('#999999'), [...paints].join());
	}
});
test('formatStamp：本地时间 YYYYMMDD-HHmm，补零', () => {
	assert.equal(formatStamp(new Date(2026, 9, 17, 15, 32, 59)), '20261017-1532');
	assert.equal(formatStamp(new Date(2026, 0, 2, 3, 4)), '20260102-0304');
});
test('sanitizeFileName：非法字符 → _，保留中文，去首尾空白和点，限长，空串回空', () => {
	assert.equal(sanitizeFileName('电源模块'), '电源模块');
	assert.equal(sanitizeFileName(' a/b\\c:d*e?f"g<h>i|j\n'), 'a_b_c_d_e_f_g_h_i_j');
	assert.equal(sanitizeFileName('..P1 . '), 'P1');
	assert.equal(sanitizeFileName('图'.repeat(200)).length, 80);
	assert.equal(sanitizeFileName('😀'.repeat(200)), '😀'.repeat(80), '按字符而不是 UTF-16 单元截断');
	assert.equal(sanitizeFileName(undefined as any), '');
	assert.equal(sanitizeFileName('...'), '');
});
test('buildFileName：<图页名>_<时间>[@Nx].<ext>，1x 不带倍率，不再有 _beautify', () => {
	const date = new Date(2026, 9, 17, 15, 32);
	assert.equal(buildFileName('电源模块', 'svg', { date }), '电源模块_20261017-1532.svg');
	assert.equal(buildFileName('电源模块', 'png', { scale: 1, date }), '电源模块_20261017-1532.png');
	assert.equal(buildFileName('电源模块', 'png', { scale: 4, date }), '电源模块_20261017-1532@4x.png');
	assert.equal(buildFileName('a/b', '.png', { scale: 2, date }), 'a_b_20261017-1532@2x.png');
	assert.equal(buildFileName('', 'svg', { date }), 'schematic_20261017-1532.svg');
	assert.doesNotMatch(buildFileName('x', 'svg'), /beautify/);
});
test('currentPageName：优先图页名，接口缺失 / 抛错 / 空名时退回导出文件名再退回 schematic', async () => {
	const ok = { dmt_Schematic: { getCurrentSchematicPageInfo: async () => ({ name: '  MCU/最小系统 ' }) } };
	assert.equal(await currentPageName(ok, 'Schematic1.svg'), 'MCU_最小系统');
	const boom = { dmt_Schematic: { getCurrentSchematicPageInfo: async () => { throw new Error('x'); } } };
	const warn = console.warn; console.warn = () => {};
	try { assert.equal(await currentPageName(boom, 'Schematic1.svg'), 'Schematic1'); } finally { console.warn = warn; }
	const empty = { dmt_Schematic: { getCurrentSchematicPageInfo: async () => ({ name: '' }) } };
	assert.equal(await currentPageName(empty, 'P2.zip'), 'P2');
	assert.equal(await currentPageName({}, undefined), 'schematic');
	assert.equal(await currentPageName(undefined), 'schematic');
});

let failed = 0;
for (const [name, fn] of tests) {
	try { await fn(); console.log(`ok   ${name}`); }
	catch (e) { failed++; console.log(`FAIL ${name}\n${(e as Error).message}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
