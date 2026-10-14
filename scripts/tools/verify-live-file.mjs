/**
 * Verify a real document against the DEPLOYED site.
 *
 * This is the end-to-end proof that matters: the same file, the same mode, run
 * in a real browser against the real origin. It is deliberately not a unit test
 * - it reports what a user would see.
 *
 * Usage: bun scripts/tools/verify-live-file.mjs <file.pdf> [mode]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', 'build');

const file = process.argv[2];
const mode = process.argv[3] ?? 'maximum';
const BASE = process.argv[4] ?? 'https://qcompress.pages.dev';
if (!file) {
	console.log('\nusage: bun scripts/tools/verify-live-file.mjs <file.pdf> [mode] [url]\n');
	process.exit(2);
}

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.wasm': 'application/wasm'
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

const bytes = new Uint8Array(await readFile(file));
const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const t0 = Date.now();
await page.goto(BASE, { waitUntil: 'load', timeout: 120_000 });
await page.waitForSelector('.drop-title', { timeout: 60_000 });

await page.setInputFiles('input[type=file]', {
	name: path.basename(file),
	mimeType: 'application/pdf',
	buffer: Buffer.from(bytes)
});
await page.waitForSelector('button.primary:has-text("Compress PDF")', { timeout: 120_000 });
await page.waitForSelector('.panel[data-stage="idle"]', { timeout: 120_000 });

await page.click(`.chip:has-text("${mode === 'maximum' ? 'Maximum' : mode === 'balanced' ? 'Balanced' : 'Lossless'}")`);
await page.click('button.primary:has-text("Compress PDF")');
await page.waitForSelector('.result, .error', { timeout: 600_000 });
const ms = Date.now() - t0;

const out = (...a) => console.log(a.join(' '));
out(`\n${path.basename(file)}  ${bytes.length} B  mode=${mode}  against ${BASE}\n`);

const rows = await page.$$eval('.report li', (ls) =>
	ls.map((li) => [
		li.querySelector('.report-key')?.textContent?.trim(),
		li.querySelector('.report-val')?.textContent?.trim()
	])
);
const sizes = await page.$$eval('.sizes dd', (ds) => ds.map((d) => d.textContent?.trim() ?? ''));

out(`  verdict : ${(await page.textContent('.verdict'))?.trim()}`);
for (const [k, v] of rows) out(`  ${String(k).padEnd(7)}: ${v}`);
out(`  sizes   : ${sizes.join('  ->  ')}`);
out(`  elapsed : ${(ms / 1000).toFixed(1)} s`);
if (errors.length) out(`  errors  : ${errors.join(' | ')}`);

const [download] = await Promise.all([page.waitForEvent('download'), page.click('a.primary')]);
const stream = await download.createReadStream();
const chunks = [];
for await (const c of stream) chunks.push(c);
const downloaded = Buffer.concat(chunks);

out(`  download: ${downloaded.length} B  (${(((bytes.length - downloaded.length) / bytes.length) * 100).toFixed(1)}% smaller)`);
out(`  header  : ${downloaded.subarray(0, 5).toString() === '%PDF-' ? 'valid PDF' : 'NOT A PDF'}`);

await browser.close();
server.close();
out('');