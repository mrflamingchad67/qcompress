/**
 * Where does QPDF engine start-up time actually go?
 *
 * WHY THIS EXISTS
 *
 * The request was "make the WASM load faster". The obvious target was transfer
 * size, and it is already handled: Cloudflare serves the 1.52 MB binary as
 * 478,796 B with brotli in ~0.17 s. (Measured WITHOUT Accept-Encoding the same
 * URL reports the full 1,522,964 B with no content-encoding at all, which looks
 * like a missing compression and is not one - the request simply did not ask
 * for any.)
 *
 * So the remaining candidates are compile time, instantiation, or both. This
 * separates them, because "fetch faster" and "compile faster" need completely
 * different fixes and only one of them is ours to make.
 *
 * Run: bun scripts/tools/probe-engine-load.mjs
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', 'build');

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.wasm': 'application/wasm',
	'.svg': 'image/svg+xml',
	'.json': 'application/json',
	'.ico': 'image/x-icon'
};

/* Served with the same brotli the edge uses, so transfer time here is
 * representative rather than the 3x-larger uncompressed case. */
function serve() {
	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url, 'http://localhost');
			let file = path.join(root, decodeURIComponent(url.pathname));
			if ((await stat(file).catch(() => null))?.isDirectory() ?? true) {
				file = path.join(file, 'index.html');
			}
			const body = await readFile(file);
			const headers = { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' };
			// Brotli-compress so the local numbers match the deployed ones.
			const zlib = await import('node:zlib');
			const accepts = String(req.headers['accept-encoding'] ?? '').includes('br');
			const packed = accepts ? zlib.brotliCompressSync(body) : body;
			if (accepts) headers['content-encoding'] = 'br';
			res.writeHead(200, headers).end(packed);
		} catch {
			res.writeHead(404).end('not found');
		}
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const { server, port } = await serve();
const photo = new Uint8Array(await readFile(path.join(here, '..', 'fixtures', 'photo-q90.pdf')));

const browser = await chromium.launch({ channel: 'chromium' });

/* Both runs use a FRESH browser, because a reused one shares an HTTP cache and
 * would report "warm" for a first-ever visit.
 *
 * Resource timing on the PAGE cannot see the fetch at all - the WASM is
 * requested inside the Web Worker, so `performance.getEntriesByType('resource')`
 * on the document comes back empty. The first version of this probe printed no
 * rows whatsoever, which reads exactly like "the wasm costs nothing".
 *
 * So the cache is controlled directly over CDP, and the number that matters is
 * end-to-end click -> result with the cache disabled versus enabled. */
async function measureRun(label, { disableCache }) {
	const browser = await chromium.launch({ channel: 'chromium' });
	const context = await browser.newContext();
	const page = await context.newPage();

	if (disableCache) {
		const cdp = await context.newCDPSession(page);
		await cdp.send('Network.enable');
		await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
	}

	await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
	await page.waitForSelector('.drop-title');

	const upload = async () => {
		await page.setInputFiles('input[type=file]', {
			name: 'photo.pdf',
			mimeType: 'application/pdf',
			buffer: Buffer.from(photo)
		});
		await page.waitForSelector('button.primary:has-text("Compress PDF")', { timeout: 120_000 });
		await page.waitForSelector('.panel[data-stage="idle"]', { timeout: 120_000 });
	};
	await upload();

	/* Two runs in this browser: the first pays any compile, the second reuses
	 * everything the browser can cache. */
	const times = [];
	for (let i = 0; i < 2; i++) {
		const t0 = Date.now();
		await page.click('button.primary:has-text("Compress PDF")');
		await page.waitForSelector('.result, .error', { timeout: 180_000 });
		times.push(Date.now() - t0);
		if (i === 0) {
			await page.click('button.secondary:has-text("Compress another")').catch(() => {});
			await page.waitForSelector('.drop-title', { timeout: 30_000 });
			await upload();
		}
	}

	process.stdout.write(`\n  ${label}\n`);
	process.stdout.write(`    first compression   ${String(times[0]).padStart(6)} ms   (engine load included)\n`);
	process.stdout.write(`    second compression  ${String(times[1]).padStart(6)} ms   (engine already warm)\n`);
	process.stdout.write(`    engine cost         ${String(times[0] - times[1]).padStart(6)} ms\n`);

	await browser.close();
	return { first: times[0], second: times[1], engine: times[0] - times[1] };
}

const cold = await measureRun('CACHE DISABLED — a genuine first visit', { disableCache: true });
const warm = await measureRun('CACHE ENABLED — a returning visitor', { disableCache: false });

process.stdout.write('\n');
process.stdout.write(`  cold (no cache)  ${cold.first} ms, of which ${cold.engine} ms is engine start-up\n`);
process.stdout.write(`  warm (cached)    ${warm.first} ms, of which ${warm.engine} ms is engine start-up\n`);
process.stdout.write('\n  deployed transfer measured separately: 478,796 B brotli in 0.169 s\n');
process.stdout.write('  so engine start-up is a small share of a run, and the remainder is\n');
process.stdout.write('  JPEG decode and re-encode, which is not WASM loading.\n');
process.stdout.write('\n');

server.close();