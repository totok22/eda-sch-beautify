/**
 * sch-beautify-core.ts — 与 eda_sch_beautify.py 等价的 SVG 处理核心（纯字符串实现，不依赖 DOM，可在 EDA 扩展与 Node 中运行）
 * 输入嘉立创EDA专业版导出的原理图 SVG 字符串，输出处理后的 SVG 字符串与统计信息。
 */
export interface HopoverOptions {
	hop: 'horizontal' | 'vertical' | 'auto';
	r?: number; // 默认 3×线宽，最小 2
	minR: number;
	gap: number;
	close: 'shrink' | 'merge';
	junctionColor: 'wire' | 'keep';
	excludeRects: Array<[number, number, number, number]>;
	avoid: boolean;
	axisTol: number;
	removeEndMarkers: boolean;
	font: string | null; // null = 不改字体
	keepBackground?: boolean; // 默认移除整页背景 rect / 根背景样式
	fontMode: 'split' | 'element'; // split: 只给中文片段包 <tspan> 设宋体，英文保持原字体
	colorTheme?: 'Default' | 'Black on White' | 'White on Black'; // 导出配色增强
}
export const defaultOptions: HopoverOptions = {
	hop: 'horizontal', minR: 1.2, gap: 1, close: 'shrink', junctionColor: 'wire', excludeRects: [],
	avoid: true, axisTol: 0.5, removeEndMarkers: true,
	font: 'SimSun, 宋体, \'Songti SC\', \'Noto Serif CJK SC\', serif',
	fontMode: 'split',
	colorTheme: 'Default',
};
export interface HopoverResult {
	svg: string;
	stats: {
		segments: number; H: number; V: number; diagonal: number;
		crossings: number; arcs: number; merged: number; mergedCrossings: number;
		hAssigned: number; vAssigned: number;
		skipped: Array<[number, number, string]>; notes: Array<[number, number, string]>;
		backgroundRemoved: number; markersFound: number; markersRemoved: number; markersNotOnWire: Array<[number, number]>;
		texts: number; fontChanged: number; fontOrig: Record<string, number>;
		dots: number; dotsRecolored: number; dotOrphan: number; colorConflicts: Array<[number, number, Record<string, number>]>;
	};
}

type M = [number, number, number, number, number, number];
type P = [number, number];
const I: M = [1, 0, 0, 1, 0, 0];
const TOL = 1e-3;
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const apply = (m: M, p: P): P => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
function inverse(m: M): M {
	const d = m[0] * m[3] - m[1] * m[2];
	const a = m[3] / d; const b = -m[1] / d; const c = -m[2] / d; const e = m[0] / d;
	return [a, b, c, e, -(a * m[4] + c * m[5]), -(b * m[4] + e * m[5])];
}
function parseTransform(s: string | undefined): M {
	let m = I;
	if (!s) return m;
	for (const mm of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
		const v = mm[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
		let t: M;
		if (mm[1] === 'matrix') t = v as M;
		else if (mm[1] === 'translate') t = [1, 0, 0, 1, v[0], v[1] ?? 0];
		else if (mm[1] === 'scale') t = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
		else if (mm[1] === 'rotate') {
			const c = Math.cos(v[0] * Math.PI / 180); const sn = Math.sin(v[0] * Math.PI / 180);
			t = [c, sn, -sn, c, 0, 0];
			if (v.length === 3) t = mul(mul([1, 0, 0, 1, v[1], v[2]], t), [1, 0, 0, 1, -v[1], -v[2]]);
		}
		else continue;
		m = mul(m, t);
	}
	return m;
}
export function fmt(n: number): string {
	let s = n.toFixed(3);
	if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
	return s;
}
const q = (v: number) => Math.round(v / TOL) * TOL;
const hypot = Math.hypot;
const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/;
const CJK_RUN = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]+/g;

interface El { innerStart?: number; tag: string; start: number; end: number; attrs: Record<string, string>; order: string[]; ctm: M; inner?: string; selfClose: boolean }

function parseAttrs(s: string): { attrs: Record<string, string>; order: string[] } {
	const attrs: Record<string, string> = {}; const order: string[] = [];
	for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
		attrs[m[1]] = m[2] ?? m[3]; order.push(m[1]);
	}
	return { attrs, order };
}
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16))).replace(/&amp;/g, '&');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** 扫描所有标签，记录 polyline/circle/ellipse/text 的位置、属性与累计 transform */
function scan(svg: string): El[] {
	const out: El[] = [];
	const stack: Array<{ tag: string; m: M; el?: El }> = [{ tag: '#root', m: I }];
	const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][^>]*>|<\/([\w:-]+)\s*>|<([\w:-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(svg))) {
		if (m[1]) { // close
			const top = stack.pop()!;
			if (top.el) { top.el.end = re.lastIndex; top.el.inner = svg.slice(top.el.innerStart!, m.index); }
			continue;
		}
		if (!m[2]) continue;
		const tag = m[2].replace(/^.*:/, '');
		const { attrs, order } = parseAttrs(m[3] || '');
		const parentM = stack[stack.length - 1].m;
		const ctm = mul(parentM, parseTransform(attrs.transform));
		const selfClose = m[4] === '/';
		let el: (El & { innerStart?: number }) | undefined;
		if (['polyline', 'circle', 'ellipse', 'text'].includes(tag)) {
			el = { tag, start: m.index, end: re.lastIndex, attrs, order, ctm, selfClose };
			if (!selfClose) el.innerStart = re.lastIndex;
			out.push(el);
		}
		if (!selfClose) stack.push({ tag, m: ctm, el });
	}
	return out;
}
const styleGet = (a: Record<string, string>, key: string): string | undefined => {
	const m = (a.style || '').match(new RegExp(`(?<![-\\w])${key}:\\s*([^;]+)`));
	return m ? m[1].trim() : a[key];
};
function setColor(a: Record<string, string>, col: string) {
	let st = a.style || '';
	for (const k of ['stroke', 'fill']) {
		const re = new RegExp(`(?<![-\\w])${k}:\\s*[^;]+`);
		st = re.test(st) ? st.replace(re, `${k}:${col}`) : `${st}${k}:${col};`;
	}
	a.style = st;
}
function buildTag(tag: string, attrs: Record<string, string>, order: string[], inner?: string) {
	const keys = [...order.filter(k => k in attrs), ...Object.keys(attrs).filter(k => !order.includes(k))];
	const at = keys.map(k => ` ${k}="${esc(attrs[k])}"`).join('');
	return inner === undefined ? `<${tag}${at}/>` : `<${tag}${at}>${inner}</${tag}>`;
}
const num = (s: string | undefined, d: number) => { const v = Number.parseFloat((s ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(v) ? v : d; };

interface Seg { el: El; i: number; p: P; q: P; kind: 'h' | 'v' | 'd'; sw: number; col: string }
interface Arc { seg: Seg; ta: number; tb: number; rx: number; ry: number; ks: number[]; merged: boolean }

function isLightBgFill(fill: string): boolean {
	const f = fill.trim().toLowerCase();
	if (['#fff', '#ffffff', '#fffcf8', '#fafafa', '#f5f4ef', '#fdfdfd', '#fcfcfc', '#f5f5f5'].includes(f)) return true;
	if (f.startsWith('#') && f.length === 7) {
		const r = Number.parseInt(f.slice(1, 3), 16);
		const g = Number.parseInt(f.slice(3, 5), 16);
		const b = Number.parseInt(f.slice(5, 7), 16);
		return r >= 235 && g >= 235 && b >= 220;
	}
	if (f.startsWith('rgb')) {
		const m = f.match(/\d+/g);
		if (m && m.length >= 3) {
			const [r, g, b] = m.map(Number);
			return r >= 235 && g >= 235 && b >= 220;
		}
	}
	return false;
}

/** 给 SVG 注入指定背景色矩形（若 bg 为 null 或 transparent 则不注入，并移除已有 data-bg） */
export function applyBackground(svg: string, bg: string | null): string {
	let out = svg.replace(/<rect\b[^>]*\bdata-bg="1"[^>]*>(?:<\/rect>)?/g, '');
	if (!bg || bg === 'transparent') {
		return out.replace(/(<svg\b[^>]*\bstyle=")([^"]*)(")/, (_, p1, p2, p3) => {
			const s = p2.replace(/background(-color)?\s*:[^;]*;?/g, '');
			return `${p1}${s}${p3}`;
		});
	}
	const m = out.match(/<svg\b[^>]*>/);
	if (!m) return out;
	const vbStr = out.match(/viewBox="([^"]+)"/)?.[1] || '0 0 100 100';
	const vb = vbStr.split(/[\s,]+/).map(Number);
	const bgRect = `<rect x="${fmt(vb[0])}" y="${fmt(vb[1])}" width="${fmt(vb[2])}" height="${fmt(vb[3])}" fill="${bg}" data-bg="1"/>`;
	const defsIdx = out.indexOf('</defs>');
	if (defsIdx !== -1) {
		const pos = defsIdx + 7;
		return out.slice(0, pos) + bgRect + out.slice(pos);
	}
	const pos = m.index! + m[0].length;
	return out.slice(0, pos) + bgRect + out.slice(pos);
}

/** 增强导出配色：当选择 Black on White 或 White on Black 时，将所有非背景/非透明图元统一转换 */
export function applyColorTheme(svg: string, theme: 'Default' | 'Black on White' | 'White on Black'): string {
	if (theme === 'Default') return svg;
	const isBow = theme === 'Black on White';
	const targetColor = isBow ? '#000000' : '#FFFFFF';

	// 转换 style="stroke: ...; fill: ..."
	let out = svg.replace(/(<(?!(?:mask|pattern|clipPath|defs)\b)[a-zA-Z0-9:-]+[^>]*\bstyle=")([^"]*)(")/gi, (_, p1, style, p3) => {
		let s = style;
		s = s.replace(/(?<![-\w])stroke:\s*([^;"]+)/gi, (m0: string, col: string) => {
			const c = col.trim().toLowerCase();
			if (c === 'none' || c === 'transparent') return m0;
			return `stroke:${targetColor}`;
		});
		s = s.replace(/(?<![-\w])fill:\s*([^;"]+)/gi, (m0: string, col: string) => {
			const c = col.trim().toLowerCase();
			if (c === 'none' || c === 'transparent') return m0;
			if (isBow && (c === '#fff' || c === '#ffffff' || c.startsWith('rgb(255, 255, 255)'))) return m0;
			return `fill:${targetColor}`;
		});
		return `${p1}${s}${p3}`;
	});

	// 转换单独的 stroke="..." 属性
	out = out.replace(/(<(?!(?:mask|pattern|clipPath|defs|rect\b[^>]*\bdata-bg="1")\b)[a-zA-Z0-9:-]+[^>]*)\bstroke="([^"]*)"/gi, (m0, p1, col) => {
		const c = col.trim().toLowerCase();
		if (c === 'none' || c === 'transparent') return m0;
		return `${p1}stroke="${targetColor}"`;
	});

	// 转换单独的 fill="..." 属性
	out = out.replace(/(<(?!(?:mask|pattern|clipPath|defs|rect\b[^>]*\bdata-bg="1")\b)[a-zA-Z0-9:-]+[^>]*)\bfill="([^"]*)"/gi, (m0, p1, col) => {
		const c = col.trim().toLowerCase();
		if (c === 'none' || c === 'transparent') return m0;
		if (isBow && (c === '#fff' || c === '#ffffff' || c.startsWith('rgb(255, 255, 255)'))) return m0;
		return `${p1}fill="${targetColor}"`;
	});

	return out;
}

/** 移除整页背景：根 <svg> 的 background 样式，以及图纸底色/整页浅色底板 <rect>（不在 defs/pattern/mask 中） */
export function stripBackground(svg: string): { svg: string; removed: number } {
	let removed = 0;
	const root = svg.match(/<svg\b[^>]*>/);
	if (!root) return { svg, removed };
	const { attrs } = parseAttrs(root[0].slice(4, -1));
	const vb = (attrs.viewBox || '0 0 0 0').trim().split(/[\s,]+/).map(Number);
	let out = svg;
	if (/background(-color)?\s*:/.test(attrs.style || '')) {
		const ns = (attrs.style || '').replace(/background(-color)?\s*:[^;]*;?/g, '');
		out = out.replace(root[0], root[0].replace(/style="[^"]*"/, `style="${ns}"`)); removed++;
	}
	const cuts: Array<[number, number]> = []; const stack: string[] = [];
	const re = /<!--[\s\S]*?-->|<[?!][^>]*>|<\/([\w:-]+)\s*>|<([\w:-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(out))) {
		if (m[1]) { stack.pop(); continue; }
		if (!m[2]) continue;
		const tag = m[2].replace(/^.*:/, '');
		if (tag === 'rect' && !stack.some(t => ['defs', 'pattern', 'mask', 'clipPath', 'symbol'].includes(t)) && vb[2] > 0) {
			const at = parseAttrs(m[3] || '').attrs;
			const fill = (styleGet(at, 'fill') || 'black').trim().toLowerCase();
			const n = (k: string) => Number.parseFloat(at[k] ?? '0');
			const w = n('width'); const h = n('height');
			const partid = at.c_partid || '';
			const id = at.id || '';
			const cls = at.class || '';

			// 绝对不删除元器件
			const isComponent = ['part', 'part_pin', 'part_attr', 'wire'].includes(partid);
			if (!isComponent && !(fill === 'none' || fill === 'transparent' || fill.startsWith('url('))) {
				const isSheetTagged = /sheet|frame|background|page/i.test(`${partid} ${id} ${cls}`);
				const isLargeArea = (w * h >= 0.2 * vb[2] * vb[3]) || (w >= 0.4 * vb[2] && h >= 0.4 * vb[3]) || (w >= 250 && h >= 200);
				const isLightBg = isLightBgFill(fill);

				if (isSheetTagged || (isLargeArea && isLightBg) || (w * h >= 0.8 * vb[2] * vb[3])) {
					let end = re.lastIndex;
					if (m[4] !== '/') { const close = out.indexOf('</rect>', end); if (close >= 0) end = close + 7; re.lastIndex = end; }
					cuts.push([m.index, end]); removed++; continue;
				}
			}
		}
		if (m[4] !== '/') stack.push(tag);
	}
	for (const [a0, b0] of cuts.reverse()) out = out.slice(0, a0) + out.slice(b0);
	return { svg: out, removed };
}

export function processSvg(svg: string, opt: Partial<HopoverOptions> = {}): HopoverResult {
	const a: HopoverOptions = { ...defaultOptions, ...opt };
	let bgRemoved = 0;
	if (!a.keepBackground) { const r = stripBackground(svg); svg = r.svg; bgRemoved = r.removed; }
	const els = scan(svg);
	const edits = new Map<El, string | null>(); // 替换内容；null = 删除
	const wires = els.filter(e => e.tag === 'polyline' && e.attrs.c_partid === 'wire');
	const segs: Seg[] = []; let diag = 0;
	for (const w of wires) {
		const v = (w.attrs.points || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
		const Ps: P[] = [];
		for (let i = 0; i + 1 < v.length; i += 2) { const p = apply(w.ctm, [v[i], v[i + 1]]); Ps.push([q(p[0]), q(p[1])]); }
		const sw = num(styleGet(w.attrs, 'stroke-width') || '1', 1) || 1;
		for (let i = 0; i < Ps.length - 1; i++) {
			const p = Ps[i]; const r = Ps[i + 1];
			if (p[0] === r[0] && p[1] === r[1]) continue;
			const kind = Math.abs(p[1] - r[1]) <= a.axisTol ? 'h' : Math.abs(p[0] - r[0]) <= a.axisTol ? 'v' : 'd';
			if (kind === 'd') diag++;
			segs.push({ el: w, i, p, q: r, kind, sw, col: styleGet(w.attrs, 'stroke') || '#000' });
		}
	}
	const key = (p: P) => `${p[0]},${p[1]}`;
	const deg = new Map<string, number>();
	for (const s of segs) for (const p of [s.p, s.q]) deg.set(key(p), (deg.get(key(p)) || 0) + 1);

	// --- 灰色未连接标记 ---
	const markerEls = new Set<El>(); let markersFound = 0; const notOnWire: Array<[number, number]> = []; let removed = 0;
	for (const c of els.filter(e => e.tag === 'circle')) {
		const st = `${c.attrs.style || ''};${c.attrs.stroke || ''}${c.attrs.fill || ''}`.toLowerCase();
		if (/stroke:\s*#999999\b/.test(st) && /fill:\s*#999999/.test(st)) {
			const [cx, cy] = apply(c.ctm, [Number(c.attrs.cx || 0), Number(c.attrs.cy || 0)]);
			const near = [...deg.keys()].map(k => k.split(',').map(Number) as P).filter(p => hypot(p[0] - cx, p[1] - cy) < 0.6);
			const ok = near.length > 0 && near.every(p => deg.get(key(p)) === 1);
			markersFound++; markerEls.add(c);
			if (a.removeEndMarkers) { edits.set(c, null); removed++; if (!ok) notOnWire.push([cx, cy]); }
		}
	}

	// --- 中文字体 ---
	let fontChanged = 0; const fontOrig: Record<string, number> = {};
	const texts = els.filter(e => e.tag === 'text');
	for (const t of texts) {
		const fam = styleGet(t.attrs, 'font-family') || '(none)';
		fontOrig[fam] = (fontOrig[fam] || 0) + 1;
		if (a.font === null) continue;
		const txt = unesc((t.inner || '').replace(/<[^>]*>/g, ''));
		if (a.fontMode === 'split' && CJK.test(txt)) {
			const font = a.font;
			const inner = (t.inner || '').replace(/(^|>)([^<]+)/g, (_m, pre: string, tx: string) =>
				pre + tx.replace(CJK_RUN, run => `<tspan style="font-family:${esc(font)};" data-cjk="1">${run}</tspan>`));
			fontChanged++;
			edits.set(t, buildTag('text', t.attrs, t.order, inner));
			continue;
		}
		if (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(txt) || /宋|黑|楷|仿宋|SimSun|SimHei|YaHei|Song|Hei|Kai|CJK/i.test(fam)) {
			let st = t.attrs.style || '';
			st = /font-family:/.test(st) ? st.replace(/font-family:\s*[^;]+/, `font-family:${a.font}`) : `${st}font-family:${a.font};`;
			t.attrs.style = st; delete t.attrs['font-family']; fontChanged++;
			edits.set(t, buildTag('text', t.attrs, t.order, t.inner));
		}
	}

	// --- 障碍物 ---
	const dots: Array<{ el: El; cx: number; cy: number; r: number }> = [];
	for (const c of els.filter(e => e.tag === 'circle')) {
		const st = (c.attrs.style || '') + (c.attrs.fill || '');
		if (st.includes('fill:none') || st.includes('fill:transparent') || markerEls.has(c)) continue;
		const [cx, cy] = apply(c.ctm, [Number(c.attrs.cx || 0), Number(c.attrs.cy || 0)]);
		dots.push({ el: c, cx, cy, r: Number(c.attrs.r ?? 2) });
	}
	const pins = els.filter(e => e.tag === 'ellipse').map((e) => {
		const [cx, cy] = apply(e.ctm, [Number(e.attrs.cx || 0), Number(e.attrs.cy || 0)]);
		return [cx, cy, Number(e.attrs.rx ?? 2)];
	});
	const tboxes: Array<[number, number, number, number]> = [];
	for (const t of texts) {
		const x = Number.parseFloat(t.attrs.x); const y = Number.parseFloat(t.attrs.y);
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		const fs = num(styleGet(t.attrs, 'font-size') || '7', 7) || 7;
		const L = [...unesc((t.inner || '').replace(/<[^>]*>/g, ''))].length * fs * 0.55;
		const anc = t.attrs['text-anchor'] || 'start';
		const x0 = anc === 'end' ? x - L : anc === 'middle' ? x - L / 2 : x;
		tboxes.push([x0, y - fs, x0 + L, y]);
	}

	// --- 节点颜色 ---
	let dotsRecolored = 0; let dotOrphan = 0; const conflicts: Array<[number, number, Record<string, number>]> = [];
	if (a.junctionColor === 'wire') {
		for (const d of dots) {
			const cnt = new Map<string, number>();
			for (const s of segs) {
				const [x0, x1] = [s.p[0], s.q[0]].sort((u, v) => u - v); const [y0, y1] = [s.p[1], s.q[1]].sort((u, v) => u - v);
				if ((s.kind === 'h' && Math.abs(d.cy - y0) < 0.5 && x0 - 0.5 <= d.cx && d.cx <= x1 + 0.5)
					|| (s.kind === 'v' && Math.abs(d.cx - x0) < 0.5 && y0 - 0.5 <= d.cy && d.cy <= y1 + 0.5))
					cnt.set(s.col, (cnt.get(s.col) || 0) + 1);
			}
			if (!cnt.size) { dotOrphan++; continue; }
			if (cnt.size > 1) conflicts.push([d.cx, d.cy, Object.fromEntries(cnt)]);
			let best = ''; let bn = -1;
			for (const [c, n] of cnt) if (n > bn) { best = c; bn = n; } // 并列取先出现者
			setColor(d.el.attrs, best); dotsRecolored++;
			edits.set(d.el, buildTag('circle', d.el.attrs, d.el.order));
		}
	}

	// --- 交叉 ---
	const H = segs.filter(s => s.kind === 'h'); const V = segs.filter(s => s.kind === 'v');
	const cross: Array<[number, number, Seg, Seg]> = []; const skipped: Array<[number, number, string]> = [];
	for (const h of H) {
		const y = (h.p[1] + h.q[1]) / 2; const [x0, x1] = [h.p[0], h.q[0]].sort((u, v) => u - v);
		for (const v of V) {
			const x = (v.p[0] + v.q[0]) / 2; const [y0, y1] = [v.p[1], v.q[1]].sort((u, w) => u - w);
			if (!(x0 + TOL < x && x < x1 - TOL && y0 + TOL < y && y < y1 - TOL)) continue;
			if ([h.p, h.q, v.p, v.q].some(e => hypot(x - e[0], y - e[1]) < Math.max(a.axisTol, TOL * 10))) { skipped.push([x, y, 'T/endpoint']); continue; }
			if (dots.some(d => hypot(x - d.cx, y - d.cy) <= d.r + 0.5)) { skipped.push([x, y, 'junction dot']); continue; }
			if (a.excludeRects.some(([ex, ey, ew, eh]) => ex <= x && x <= ex + ew && ey <= y && y <= ey + eh)) { skipped.push([x, y, 'excluded rect']); continue; }
			cross.push([x, y, h, v]);
		}
	}
	const baseR = (s: Seg) => a.r ?? Math.max(2, 3 * s.sw);
	function clearR(seg: Seg, t: number, r: number): [number | null, string | null] {
		if (!a.avoid) return [r, null];
		const hz = seg.kind === 'h'; const fixed = hz ? seg.p[1] : seg.p[0];
		let reason: string | null = null;
		while (r >= a.minR) {
			const bx = hz ? [t - r, fixed - r - 0.5, t + r, fixed - 0.2] : [fixed + 0.2, t - r, fixed + r + 0.5, t + r];
			let hit: string | null = null;
			for (const d of dots) if (bx[0] - d.r < d.cx && d.cx < bx[2] + d.r && bx[1] - d.r < d.cy && d.cy < bx[3] + d.r) { hit = 'dot'; break; }
			if (!hit) for (const [cx, cy, cr] of pins) if (bx[0] - cr < cx && cx < bx[2] + cr && bx[1] - cr < cy && cy < bx[3] + cr) { hit = 'pin'; break; }
			if (!hit) for (const [tx0, ty0, tx1, ty1] of tboxes) if (bx[0] < tx1 && tx0 < bx[2] && bx[1] < ty1 && ty0 < bx[3]) { hit = 'text'; break; }
			if (!hit) return [r, reason];
			reason = hit; r -= 0.25;
		}
		return [null, reason];
	}
	function plan(asg: string[]) {
		const per = new Map<Seg, Array<[number, number]>>();
		cross.forEach(([x, y, h, v], k) => {
			const [seg, t] = asg[k] === 'h' ? [h, x] : [v, y];
			if (!per.has(seg)) per.set(seg, []);
			per.get(seg)!.push([t, k]);
		});
		const arcs: Arc[] = []; const skip: number[] = []; const notes: Array<[number, string]> = [];
		for (const [seg, lst0] of per) {
			const ax = seg.kind === 'h' ? 0 : 1; const p = seg.p; const qq = seg.q; const s = qq[ax] > p[ax] ? 1 : -1;
			const R = baseR(seg);
			const lst = lst0.slice().sort((u, v) => s * u[0] - s * v[0]);
			const groups: Array<Array<[number, number]>> = [];
			for (const e of lst) {
				const g = groups[groups.length - 1];
				if (g && s * (e[0] - g[g.length - 1][0]) < 2 * R + a.gap) g.push(e); else groups.push([e]);
			}
			let cur = p[ax];
			groups.forEach((g, gi) => {
				const last = g[g.length - 1][0];
				const nxt = gi + 1 < groups.length ? groups[gi + 1][0][0] : qq[ax];
				const limEnd = Math.min(s * (g[0][0] - cur), s * (nxt - last) - (gi + 1 < groups.length ? R : 0)) - a.gap;
				let rs = R;
				if (g.length > 1) { let pitch = Infinity; for (let j = 0; j < g.length - 1; j++) pitch = Math.min(pitch, s * (g[j + 1][0] - g[j][0])); rs = (pitch - a.gap) / 2; }
				if (a.close === 'shrink' && g.length > 1 && rs >= a.minR) {
					const r = Math.min(R, rs, limEnd);
					if (r < a.minR) { skip.push(...g.map(e => e[1])); return; }
					let rr = r;
					for (const [t, k] of g) { const [c, why] = clearR(seg, t, rr); if (c === null) { notes.push([k, String(why)]); continue; } rr = Math.min(rr, c); }
					for (const [t, k] of g) arcs.push({ seg, ta: t - s * rr, tb: t + s * rr, rx: rr, ry: rr, ks: [k], merged: false });
					if (rr < R) for (const [, k] of g) notes.push([k, `shrunk to ${fmt(rr)}`]);
					cur = last + s * rr;
				}
				else {
					let r = Math.min(R, limEnd);
					if (r < a.minR) { skip.push(...g.map(e => e[1])); return; }
					for (const [t, k] of g) {
						const [c, why] = clearR(seg, t, r);
						if (c !== null && c < r) { r = c; notes.push([k, `shrunk (${why})`]); }
						else if (c === null) notes.push([k, `touches ${why}`]);
					}
					const ta = g[0][0] - s * r; const tb = last + s * r;
					arcs.push({ seg, ta, tb, rx: Math.abs(tb - ta) / 2, ry: r, ks: g.map(e => e[1]), merged: g.length > 1 });
					cur = tb;
				}
			});
		}
		return { arcs, skip, notes };
	}
	const n = cross.length;
	let asg: string[];
	if (a.hop === 'auto') {
		const cost = (x: string[]) => { const r = plan(x); return r.arcs.length + 10 * r.skip.length; };
		asg = Array.from({ length: n }, () => 'h'); let best = cost(asg);
		const moves: number[][] = Array.from({ length: n }, (_, k) => [k]);
		const byv = new Map<Seg, number[]>();
		cross.forEach((c, k) => { if (!byv.has(c[3])) byv.set(c[3], []); byv.get(c[3])!.push(k); });
		for (const ks of byv.values()) if (ks.length > 1) moves.push(ks);
		let improved = true;
		while (improved) {
			improved = false;
			for (const ks of moves) {
				const tr = asg.slice(); for (const k of ks) tr[k] = tr[k] === 'h' ? 'v' : 'h';
				const c = cost(tr); if (c < best) { asg = tr; best = c; improved = true; }
			}
		}
	}
	else asg = Array.from({ length: n }, () => (a.hop === 'horizontal' ? 'h' : 'v'));
	const { arcs, skip, notes } = plan(asg);
	for (const k of skip) skipped.push([cross[k][0], cross[k][1], 'no room (near corner/end)']);

	// --- 重建导线 ---
	const byEl = new Map<El, Arc[]>();
	for (const arc of arcs) { if (!byEl.has(arc.seg.el)) byEl.set(arc.seg.el, []); byEl.get(arc.seg.el)!.push(arc); }
	for (const w of wires) {
		const list = byEl.get(w); if (!list) continue;
		const m = w.ctm; const inv = inverse(m); const loc = (p: P) => apply(inv, p);
		const my = segs.filter(s => s.el === w);
		const st = loc(my[0].p);
		let d = `M${fmt(st[0])} ${fmt(st[1])}`;
		for (const seg of my) {
			const hz = seg.kind === 'h'; const ax = hz ? 0 : 1; const s = seg.q[ax] > seg.p[ax] ? 1 : -1;
			const sa = list.filter(x => x.seg === seg).sort((u, v) => s * u.ta - s * v.ta);
			const pt = (t: number): P => hz ? [t, (seg.p[1] + seg.q[1]) / 2] : [(seg.p[0] + seg.q[0]) / 2, t];
			for (const arc of sa) {
				const A = loc(pt(arc.ta)); const B = loc(pt(arc.tb));
				let sweep = hz ? (s > 0 ? 1 : 0) : (s > 0 ? 0 : 1);
				if (m[0] * m[3] - m[1] * m[2] < 0) sweep ^= 1;
				const [rx, ry] = hz ? [arc.rx, arc.ry] : [arc.ry, arc.rx];
				d += ` L${fmt(A[0])} ${fmt(A[1])} A${fmt(rx)} ${fmt(ry)} 0 0 ${sweep} ${fmt(B[0])} ${fmt(B[1])}`;
			}
			const e = loc(seg.q); d += ` L${fmt(e[0])} ${fmt(e[1])}`;
		}
		const at = { ...w.attrs }; delete at.points;
		at.d = d; at['data-hopover'] = '1';
		if (!(at.style || '').includes('fill')) at.style = `${at.style || ''}fill:none;`;
		edits.set(w, buildTag('path', at, w.order.filter(k => k !== 'points')));
	}

	// --- 应用编辑（从后往前） ---
	let out = svg;
	for (const [el, rep] of [...edits.entries()].sort((u, v) => v[0].start - u[0].start)) out = out.slice(0, el.start) + (rep ?? '') + out.slice(el.end);

	if (a.colorTheme && a.colorTheme !== 'Default') {
		out = applyColorTheme(out, a.colorTheme);
	}

	const merged = arcs.filter(x => x.merged);
	return {
		svg: out,
		stats: {
			segments: segs.length, H: H.length, V: V.length, diagonal: diag, crossings: n, arcs: arcs.length,
			merged: merged.length, mergedCrossings: merged.reduce((s, x) => s + x.ks.length, 0),
			hAssigned: asg.filter(x => x === 'h').length, vAssigned: asg.filter(x => x === 'v').length,
			skipped, notes: notes.map(([k, w]) => [cross[k][0], cross[k][1], w]),
			backgroundRemoved: bgRemoved, markersFound, markersRemoved: removed, markersNotOnWire: notOnWire,
			texts: texts.length, fontChanged, fontOrig, dots: dots.length, dotsRecolored, dotOrphan, colorConflicts: conflicts,
		},
	};
}

// ======================= 区域裁剪 =======================
export type Rect = [number, number, number, number]; // x, y, w, h（SVG viewBox 坐标）

function pathBBox(d: string): Rect | null {
	const toks = d.match(/[a-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi) || [];
	let x = 0; let y = 0; let sx = 0; let sy = 0; let cmd = 'M'; const xs: number[] = []; const ys: number[] = [];
	let i = 0;
	const nx = () => Number(toks[i++]);
	while (i < toks.length) {
		if (/[a-z]/i.test(toks[i])) cmd = toks[i++];
		const rel = cmd === cmd.toLowerCase(); const C = cmd.toUpperCase();
		if (C === 'Z') { x = sx; y = sy; continue; }
		const n = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7 }[C as 'M'];
		if (!n || i + n > toks.length) break;
		const v = Array.from({ length: n }, nx);
		if (C === 'H') x = rel ? x + v[0] : v[0];
		else if (C === 'V') y = rel ? y + v[0] : v[0];
		else {
			for (let k = 0; k + 1 < n; k += 2) { if (C === 'A' && k < 5) continue; xs.push(rel ? x + v[k] : v[k]); ys.push(rel ? y + v[k + 1] : v[k + 1]); }
			const ex = v[n - 2]; const ey = v[n - 1];
			x = rel ? x + ex : ex; y = rel ? y + ey : ey;
		}
		xs.push(x); ys.push(y);
		if (C === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
	}
	if (!xs.length) return null;
	const x0 = Math.min(...xs); const y0 = Math.min(...ys);
	return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
}

/** 返回 SVG 中每个带 id 的元素（含其后代）的包围盒，以及每个元素的 id/data-group-id/祖先 id */
export function elementBoxes(svg: string): Array<{ ids: string[]; box: Rect }> {
	const out: Array<{ ids: string[]; box: Rect }> = [];
	const stack: Array<{ m: M; ids: string[] }> = [{ m: I, ids: [] }];
	const re = /<!--[\s\S]*?-->|<[?!][^>]*>|<\/([\w:-]+)\s*>|<([\w:-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
	let mm: RegExpExecArray | null;
	while ((mm = re.exec(svg))) {
		if (mm[1]) { stack.pop(); continue; }
		if (!mm[2]) continue;
		const tag = mm[2].replace(/^.*:/, ''); const { attrs } = parseAttrs(mm[3] || '');
		const top = stack[stack.length - 1];
		const m = mul(top.m, parseTransform(tag === 'text' ? undefined : attrs.transform));
		const ids = [...top.ids, attrs.id, attrs['data-group-id']].filter(Boolean) as string[];
		let pts: P[] = [];
		const n = (k: string) => Number.parseFloat(attrs[k] ?? '0');
		if (tag === 'polyline' || tag === 'polygon') { const v = (attrs.points || '').trim().split(/[\s,]+/).map(Number); for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]); }
		else if (tag === 'line') pts = [[n('x1'), n('y1')], [n('x2'), n('y2')]];
		else if (tag === 'rect') pts = [[n('x'), n('y')], [n('x') + n('width'), n('y') + n('height')]];
		else if (tag === 'circle' || tag === 'ellipse') { const rx = n(tag === 'circle' ? 'r' : 'rx'); const ry = n(tag === 'circle' ? 'r' : 'ry'); pts = [[n('cx') - rx, n('cy') - ry], [n('cx') + rx, n('cy') + ry]]; }
		else if (tag === 'path') { const b = pathBBox(attrs.d || ''); if (b) pts = [[b[0], b[1]], [b[0] + b[2], b[1] + b[3]]]; }
		else if (tag === 'text') { const fs = num(styleGet(attrs, 'font-size') || '7', 7); const x = n('x'); const y = n('y'); pts = [[x - fs, y - fs], [x + fs, y]]; }
		if (pts.length) {
			const g = pts.map(p => apply(m, p)); const xs = g.map(p => p[0]); const ys = g.map(p => p[1]);
			const x0 = Math.min(...xs); const y0 = Math.min(...ys);
			out.push({ ids, box: [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0] });
		}
		if (mm[4] !== '/') stack.push({ m, ids });
	}
	return out;
}

/** 选中图元 ID → SVG 包围盒（按 id / data-group-id / id 前缀匹配）。匹配不到返回 null */
export function bboxForIds(svg: string, primitiveIds: string[]): { box: Rect; matched: number } | null {
	const want = new Set(primitiveIds);
	let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity; let matched = 0;
	for (const { ids, box } of elementBoxes(svg)) {
		if (!ids.some(id => want.has(id) || want.has(id.split('-')[0]))) continue;
		matched++;
		x0 = Math.min(x0, box[0]); y0 = Math.min(y0, box[1]); x1 = Math.max(x1, box[0] + box[2]); y1 = Math.max(y1, box[1] + box[3]);
	}
	return matched ? { box: [x0, y0, x1 - x0, y1 - y0], matched } : null;
}

/** 修改根 <svg> 的 viewBox 为 rect(+margin)，并按原比例调整 width/height */
export function cropSvg(svg: string, rect: Rect, margin = 10): string {
	const m = svg.match(/<svg\b[^>]*>/); if (!m) return svg;
	const tag = m[0]; const { attrs, order } = parseAttrs(tag.slice(4, -1));
	const vb = (attrs.viewBox || '').split(/[\s,]+/).map(Number);
	const scale = vb.length === 4 && attrs.width ? Number.parseFloat(attrs.width) / vb[2] : 1;
	const r: Rect = [rect[0] - margin, rect[1] - margin, rect[2] + 2 * margin, rect[3] + 2 * margin];
	attrs.viewBox = r.map(v => fmt(v)).join(' ');
	attrs.width = fmt(r[2] * scale); attrs.height = fmt(r[3] * scale);
	const at = order.concat(['viewBox', 'width', 'height'].filter(k => !order.includes(k))).map(k => ` ${k}="${esc(attrs[k])}"`).join('');
	return svg.replace(tag, `<svg${at}>`);
}
