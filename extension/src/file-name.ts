/** 导出文件命名：`<图页名>_<YYYYMMDD-HHmm>[@Nx].<ext>`（纯函数 + 一个读取图页名的小封装，面板和快速导出共用） */

const FALLBACK = 'schematic';
const MAX_BASE_LEN = 80;

/** 去掉 Windows / macOS 文件名里的非法字符，首尾空白与点，过长则按字符截断；清洗后为空返回空串 */
export function sanitizeFileName(s: string): string {
	// eslint-disable-next-line no-control-regex
	const cleaned = String(s ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
	return Array.from(cleaned).slice(0, MAX_BASE_LEN).join('').replace(/[.\s]+$/g, '');
}

/** 本地时间，精确到分钟：20261017-1532 */
export function formatStamp(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 拼出最终文件名；scale 为 1 或缺省时不带倍率后缀 */
export function buildFileName(base: string, ext: string, opts: { scale?: number; date?: Date } = {}): string {
	const tag = opts.scale && opts.scale !== 1 ? `@${opts.scale}x` : '';
	return `${sanitizeFileName(base) || FALLBACK}_${formatStamp(opts.date)}${tag}.${ext.replace(/^\./, '')}`;
}

/** 当前图页名；接口是 @beta，取不到 / 抛错 / 为空时依次退回 fallback（一般是 EDA 导出文件的名字）和 schematic */
export async function currentPageName(eda: any, fallback?: string): Promise<string> {
	try {
		const info = await eda?.dmt_Schematic?.getCurrentSchematicPageInfo?.();
		const n = sanitizeFileName(info?.name);
		if (n)
			return n;
	}
	catch (e) { console.warn('getCurrentSchematicPageInfo failed', e); }
	return sanitizeFileName((fallback || '').replace(/\.(svg|zip)$/i, '')) || FALLBACK;
}
