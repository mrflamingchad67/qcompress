/**
 * Cross-engine check: does a real compression actually work in each engine?
 *
 * WHY THIS EXISTS
 *
 * `scripts/tools/probe-engines.mjs` showed all three engines mount the app and
 * expose DecompressionStream, Blob.stream and getReader. That is a weak claim:
 * it proves the HTML parsed and the API surface exists, not that the QPDF WASM
 * module loaded, that the second WASM module (jSquash) initialised, or that the
 * worker completed a pass. A page can mount perfectly and fail on the first
 * real document - which is the shape of defect this project has hit before.
 *
 * This drives an actual compression of a real fixture in each engine and checks
 * that bytes came back. It asserts nothing on purpose: it reports, so that the
 * result of parameterising `test-browser.mjs` is known before the refactor is
 * judged by its own output.
 *
 * Run: bun scripts/tools/probe-compress-engines.mjs
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as playwright from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const root = path.join(repo, 'build');

/* The MODE has to be selected through the radio input, not a button.
 *
 * The first version of this probe looked for `button:has-text("Maximum")`,
 * which matches nothing, so every case silently ran the default mode while
 * being labelled "lossless" - and then reported Balanced re-encoding images
 * lossily, which read as an honesty bug in the UI and was not one. `mode`
 * defaults to `balanced` in +page.svelte; the chips are
 * `input[type=radio][name=mode][value=<id>]`.
 *
 * Fixtures chosen for what each one exercises:
 *  - jpeg-flate-wrapped: /Filter [/FlateDecode /DCTDecode], so the worker's
 *    DecompressionStream path in src/lib/qpdf/zip.ts is actually taken.
 *  - photo-q90: a plain JPEG, re-encoded only in the lossy modes. */
const CASES = [
	['jpeg-flate-wrapped.pdf', 'lossless', 'Flate-wrapped JPEG via zip.ts'],
	['jpeg-flate-wrapped.pdf', 'balanced', 'Flate-wrapped JPEG, re-encoded'],
	['photo-q90.pdf', 'maximum', 'the JPEG codec path']
];

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
const bytes = new Uint8Array(await readFile(path.join(repo, 'scripts/fixtures/jpeg-flate-wrapped.pdf')));
const q90 = new Uint8Array(await readFile(path.join(repo, 'scripts/fixtures/photo-q90.pdf')));

const ENGINES = [
	['chromium', playwright.chromium, { channel: 'chromium' }],
	['firefox', playwright.firefox, {}],
	['webkit', playwright.webkit, {}]
];

async function runCase(page, data, name, mode) {
	const errors = [];
	const onError = (e) => errors.push(String(e).split('\n')[0].slice(0, 100));
	page.on('pageerror', onError);

	const t0 = Date.now();
	try {
		await page.setInputFiles('input[type=file]', {
			name,
			mimeType: 'application/pdf',
			buffer: Buffer.from(data)
		});
		await page.waitForSelector('button.primary:has-text("Compress PDF")', { timeout: 120_000 });
		await page.waitForSelector('.panel[data-stage="idle"]', { timeout: 120_000 });

		/* Select the mode through its radio input. Clicking a label works in
		 * Chromium but the input is the reliable target across engines. */
		await page.check(`input[name="mode"][value="${mode}"]`, { timeout: 15_000 });
		const selected = await page.evaluate(
			() => document.querySelector('input[name="mode"]:checked')?.value ?? null
		);
		if (selected !== mode) {
			return { ok: false, ms: Date.now() - t0, error: `mode did not switch (radio says "${selected}")`, errors };
		}

		await page.click('button.primary:has-text("Compress PDF")');
		await page.waitForSelector('.result, .error', { timeout: 180_000 });

		const outcome = await page.evaluate(() => {
			const err = document.querySelector('.error');
			const rows = [...document.querySelectorAll('.report li')];
			const report = Object.fromEntries(
				rows.map((li) => [li.querySelector('.report-key')?.textContent?.trim(), li.querySelector('.report-val')?.textContent?.trim()])
			);
			const dd = [...document.querySelectorAll('.sizes dd')].map((d) => d.textContent?.trim());
			return { error: err ? err.textContent?.trim().slice(0, 120) : null, report, sizes: dd };
		});

		const ms = Date.now() - t0;
		return { ok: !outcome.error, ms, ...outcome, errors };
	} catch (err) {
		return { ok: false, ms: Date.now() - t0, error: String(err.message).split('\n')[0].slice(0, 110), errors };
	} finally {
		page.off('pageerror', onError);
	}
}

process.stdout.write('\n');
process.stdout.write('  engine     case                            result\n');
process.stdout.write('  ' + '-'.repeat(78) + '\n');

for (const [engineName, engine, options] of ENGINES) {
	let browser;
	try {
		browser = await engine.launch(options);
	} catch (err) {
		process.stdout.write(`  ${engineName.padEnd(10)} LAUNCH FAILED: ${String(err.message).split('\n')[0].slice(0, 50)}\n`);
		continue;
	}

	for (const [file, mode, note] of CASES) {
		const page = await browser.newPage();
		const requestUrls = [];
		page.on('request', (r) => requestUrls.push(r.url()));
		await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30_000 });
		await page.waitForSelector('.drop-title', { timeout: 30_000 });

		const r = await runCase(page, file === 'photo-q90.pdf' ? q90 : bytes, file, mode);
		const wasmFetched = requestUrls.some((u) => u.endsWith('.wasm'));

		const label = `${file.replace('.pdf', '')} ${mode}`;
		process.stdout.write(`  ${engineName.padEnd(10)} ${label.padEnd(32)} `);
		if (r.ok) {
			const processed = r.sizes?.[1] ?? '?';
			const mode_shown = r.report?.mode ?? '?';
			const images = r.report?.images ?? '';
			process.stdout.write(`OK  ${String(r.ms).padStart(6)} ms  out ${String(processed).padStart(7)}  mode=${mode_shown}\n`);
			process.stdout.write(`  ${''.padEnd(10)} ${''.padEnd(32)}      ${String(images).slice(0, 58)}\n`);
		} else {
			process.stdout.write(`FAILED ${String(r.ms).padStart(6)} ms\n`);
			process.stdout.write(`  ${''.padEnd(10)} ${''.padEnd(32)}      ${(r.error ?? 'unknown').slice(0, 62)}\n`);
		}
		if (!wasmFetched) process.stdout.write(`  ${''.padEnd(10)} ${''.padEnd(32)}      NOTE: no .wasm request was made\n`);
		for (const e of (r.errors ?? []).slice(0, 2)) process.stdout.write(`  ${''.padEnd(10)} ${''.padEnd(32)}      pageerror: ${e.slice(0, 58)}\n`);
		void note;

		await page.close();
	}
	await browser.close();
}

server.close();
process.stdout.write('\n');