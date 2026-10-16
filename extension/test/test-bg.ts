import fs from 'node:fs';
import { applyBackground, cropSvg, processSvg } from '../src/sch-beautify-core.ts';

const src = fs.readFileSync('dist/test_input.svg', 'utf8');
const res = processSvg(src);
console.log('Background removed count:', res.stats.backgroundRemoved);
console.log('Contains original sheet_bg?:', res.svg.includes('sheet_bg'));

// 测试 paper 背景注入
const paperSvg = applyBackground(res.svg, '#F5F4EF');
console.log('Has paper data-bg rect?:', paperSvg.includes('data-bg="1"') && paperSvg.includes('#F5F4EF'));

// 测试手动框选裁切超出原图纸范围时
const cropped = cropSvg(res.svg, [50, -800, 1024, 571], 0);
const finalPaper = applyBackground(cropped, '#F5F4EF');
console.log('Cropped final viewBox:', finalPaper.match(/viewBox="([^"]+)"/)?.[1]);
console.log('Cropped background rect:', finalPaper.match(/<rect[^>]*data-bg="1"[^>]*>/)?.[0]);
