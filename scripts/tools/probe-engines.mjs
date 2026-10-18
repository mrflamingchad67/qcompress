/**
 * Engine smoke test: does the built app load, and are the platform APIs present?
 *
 * Run before parameterising test-browser.mjs, so the refactor is informed by
 * what actually differs rather than by what is assumed to differ. Prints no
 * assertions on purpose - this reports, it does not gate.
 *
 * Run: bun scripts/tools/probe-engines.mjs
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as playwright from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', 'build');

const MIME = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.wasm': 'application/wasm',
	'.json': 'application/json',
	'.svg': 'image/svg+xml'
};

function serve() {
	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url, 'http://localhost');
			let file = path.join(root, decodeURIComponent(url.pathname));
			if ((await stat(file).catch(() => null))?.isDirectory() ?? true) {
				file = path.join(file, 'index.html');
			}
			const body = await readFile(file);
			res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
			res.end(body);
		} catch {
			res.writeHead(404).end('not found');
		}
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const { server, port } = await serve();

const ENGINES = [
	['chromium', playwright.chromium, { channel: 'chromium' }],
	['firefox', playwright.firefox, {}],
	['webkit', playwright.webkit, {}]
];

process.stdout.write('\n');
process.stdout.write('  engine     mounted   platform API availability\n');
process.stdout.write('  ' + '-'.repeat(78) + '\n');

for (const [name, engine, options] of ENGINES) {
	let browser;
	try {
		browser = await engine.launch(options);
	} catch (err) {
		process.stdout.write(`  ${name.padEnd(10)} LAUNCH FAILED: ${String(err.message).split('\n')[0].slice(0, 60)}\n`);
		continue;
	}

	const page = await browser.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e).split('\n')[0].slice(0, 90)));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 86)}`);
	});

	let mounted = false;
	let loadError = '';
	try {
		await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
		await page.waitForSelector('.drop-title', { timeout: 30000 });
		mounted = true;
	} catch (err) {
		loadError = String(err.message).split('\n')[0].slice(0, 70);
	}

	const api = await page
		.evaluate(() => ({
			DecompressionStream: typeof DecompressionStream,
			'Blob.stream': typeof Blob.prototype.stream,
			'stream.getReader': typeof ReadableStream.prototype.getReader,
			'reader.cancel': typeof ReadableStreamDefaultReader.prototype.cancel,
			Worker: typeof Worker,
			WebAssembly: typeof WebAssembly,
			'import.meta.url': typeof location
		}))
		.catch(() => null);

	const ua = await page.evaluate(() => navigator.userAgent).catch(() => '?');

	process.stdout.write(`  ${name.padEnd(10)} ${mounted ? 'yes' : 'NO'}       `);
	if (api) {
		const missing = Object.entries(api)
			.filter(([, v]) => v === 'undefined')
			.map(([k]) => k);
		process.stdout.write(missing.length ? `MISSING: ${missing.join(', ')}\n` : 'all present\n');
	} else {
		process.stdout.write('could not evaluate\n');
	}
	process.stdout.write(`            ${ua.slice(0, 76)}\n`);
	if (loadError) process.stdout.write(`            load: ${loadError}\n`);
	for (const e of errors.slice(0, 5)) process.stdout.write(`            ERROR ${e}\n`);

	await browser.close();
}

server.close();
process.stdout.write('\n');