/** Capture screenshots of each UI state for visual review. */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textPdf, minimalPdf } from '../lib/fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', 'build');
const outDir = path.join(here, '..', '..', '.screenshots');
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.wasm': 'application/wasm',
	'.svg': 'image/svg+xml'
};
const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, 'http://localhost');
		let f = path.join(root, decodeURIComponent(url.pathname));
		if ((await stat(f).catch(() => null))?.isDirectory() ?? true) f = path.join(f, 'index.html');
		res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' });
		res.end(await readFile(f));
	} catch {
		res.writeHead(404).end('nf');
	}
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium' });
const base = `http://127.0.0.1:${port}/`;

async function shot(name, { scheme = 'light', viewport = { width: 900, height: 900 }, actions } = {}) {
	const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2 });
	const page = await ctx.newPage();
	await page.goto(base, { waitUntil: 'load' });
	await page.waitForSelector('.drop-title');
	if (actions) await actions(page);
	await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
	await ctx.close();
	console.log('saved', name);
}

const pick = (bytes, name) => async (page) => {
	await page.setInputFiles('input[type=file]', {
		name,
		mimeType: 'application/pdf',
		buffer: Buffer.from(bytes)
	});
	await page.waitForSelector('button.primary:has-text("Compress PDF")');
	await page.waitForSelector('.panel[data-stage="idle"]');
};

await shot('01-initial-light');
await shot('02-initial-dark', { scheme: 'dark' });
await shot('03-selected', { actions: pick(textPdf(8, 45), 'annual-report-2026.pdf') });
await shot('04-result', {
	actions: async (page) => {
		await pick(textPdf(8, 45), 'annual-report-2026.pdf')(page);
		await page.click('button.primary:has-text("Compress PDF")');
		await page.waitForSelector('.result', { timeout: 120000 });
	}
});
await shot('05-noreduction', {
	actions: async (page) => {
		await pick(minimalPdf(), 'tiny.pdf')(page);
		await page.click('button.primary:has-text("Compress PDF")');
		await page.waitForSelector('.result', { timeout: 120000 });
	}
});
await shot('06-error', {
	actions: async (page) => {
		await page.setInputFiles('input[type=file]', {
			name: 'notes.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('not a pdf')
		});
		await page.waitForSelector('.error');
	}
});
await shot('07-mobile', {
	viewport: { width: 390, height: 844 },
	actions: pick(textPdf(8, 45), 'annual-report-2026.pdf')
});
await shot('08-mobile-result', {
	viewport: { width: 390, height: 844 },
	actions: async (page) => {
		await pick(textPdf(8, 45), 'annual-report-2026.pdf')(page);
		await page.click('button.primary:has-text("Compress PDF")');
		await page.waitForSelector('.result', { timeout: 120000 });
	}
});

await browser.close();
server.close();
console.log('screenshots in', outDir);