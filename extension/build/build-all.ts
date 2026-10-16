import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import fsExtra from 'fs-extra';
import commonConfig from '../config/esbuild.common.ts';
import extensionConfig from '../extension.json' with { type: 'json' };
import { fixUuid, packageExtension, testUuid } from './utils.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function build() {
	console.log('Building extension...');
	const distDir = path.join(rootDir, 'dist');
	const iframeDir = path.join(rootDir, 'iframe');

	// 1. 清理目录
	fsExtra.emptyDirSync(distDir);
	fsExtra.ensureDirSync(iframeDir);

	// 2. 构建主入口 dist/index.js
	console.log('Compiling extension entry (dist/index.js)...');
	await esbuild.build(commonConfig);

	// 3. 构建 iframe-app.ts 并内联到 iframe/panel.html
	console.log('Compiling iframe app (iframe/panel.html)...');
	const iframeBuildResult = await esbuild.build({
		entryPoints: [path.join(rootDir, 'src/iframe-app.ts')],
		bundle: true,
		format: 'iife',
		target: 'es2019',
		minify: true,
		write: false,
	});

	const jsCode = iframeBuildResult.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
	const panelHtml = fs.readFileSync(path.join(rootDir, 'src/panel.html'), 'utf8');
	const inlinedHtml = panelHtml.replace('<script src="panel.js"></script>', () => `<script>${jsCode}</script>`);
	fs.writeFileSync(path.join(iframeDir, 'panel.html'), inlinedHtml, 'utf8');

	// 4. 打包 .eext 扩展包
	console.log('Packaging extension (.eext)...');
	if (!testUuid(extensionConfig.uuid)) {
		const newExtensionConfig = { ...extensionConfig };
		// @ts-expect-error - Removing default property
		delete newExtensionConfig.default;
		newExtensionConfig.uuid = fixUuid(extensionConfig.uuid);
		fsExtra.writeJsonSync(path.join(rootDir, 'extension.json'), newExtensionConfig, { spaces: '\t', EOL: '\n', encoding: 'utf-8' });
	}

	const extensionName = extensionConfig.name ?? 'extension';
	const extensionVersion = extensionConfig.version ?? '1.0.0';
	const outPackageDir = path.join(__dirname, 'dist');
	fsExtra.ensureDirSync(outPackageDir);
	const outputPath = path.join(outPackageDir, `${extensionName}_v${extensionVersion}.eext`);

	await packageExtension(rootDir, outputPath);
	fsExtra.copySync(outputPath, path.join(distDir, path.basename(outputPath)));

	console.log(`\nBuild successfully completed!`);
	console.log(`Package output: ${path.join(distDir, path.basename(outputPath))}`);
}

build().catch((err) => {
	console.error('Build failed:', err);
	process.exit(1);
});
