/**
 * Live smoke test against the deployed site.
 *
 * Proves the real thing works over the internet, not just that it returns 200:
 *   - the app boots and the WASM engine loads from the live origin
 *   - a PDF can be selected and really compressed
 *   - the downloaded bytes are a genuine, smaller PDF
 *   - displayed sizes match the measured bytes
 *   - the lazily-loaded JPEG codec serves correctly from the CDN (wrong MIME
 *     type or a bad cache rule only shows up in production)
 *   - the lossy modes really re-encode, not just run silently
 *   - no request ever carries document bytes
 *
 * Usage: bun scripts/test/test-live.mjs [url]
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textPdf } from '../lib/fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] ?? 'https://qcompress.pages.dev';

let passed = 0,
	failed = 0;
const failures = [];
function check(name, condition, detail = '') {
	if (condition) {
		passed++;
		console.log(`  PASS  ${name}`);
	} else {
		failed++;
		failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
		console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
	}
}

console.log(`\nLive smoke test: ${BASE}\n`);

const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext();
const page = await context.newPage();

const requests = [];
page.on('request', (r) => requests.push(r.url()));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'load', timeout: 120_000 });
await page.waitForSelector('.drop-title', { timeout: 60_000 });
check('app boots from the live origin', true);
check('title', (await page.title()) === 'QCompress', await page.title());
check('footer source link', (await page.getAttribute('a.source', 'href')) === 'https://github.com/mrflamingchad67/qcompress');

// --- compress a real document ---------------------------------------------
const bytes = textPdf(8, 45);
await page.setInputFiles('input[type=file]', {
	name: 'live-test.pdf',
	mimeType: 'application/pdf',
	buffer: Buffer.from(bytes)
});
await page.waitForSelector('button.primary:has-text("Compress PDF")', { timeout: 120_000 });
await page.waitForSelector('.panel[data-stage="idle"]', { timeout: 120_000 });
check('WASM engine inspects the document over the network', true);

await page.click('button.primary:has-text("Compress PDF")');
await page.waitForSelector('.result', { timeout: 240_000 });
check('compression completes on the live site', true);

const [download] = await Promise.all([page.waitForEvent('download'), page.click('a.primary')]);
const stream = await download.createReadStream();
const chunks = [];
for await (const c of stream) chunks.push(c);
const out = Buffer.concat(chunks);

check('downloaded file is a real PDF', out.subarray(0, 5).toString() === '%PDF-');
check('downloaded file is smaller than the input', out.length < bytes.length, `${out.length} vs ${bytes.length}`);
check('filename is correct', download.suggestedFilename() === 'live-test-compressed.pdf', download.suggestedFilename());

const sizes = await page.$$eval('.sizes dd', (ds) => ds.map((d) => d.textContent?.trim() ?? ''));
const toBytes = (s) => {
	const m = /^([\d.]+)\s*(B|KB|MB)$/.exec(s.trim());
	if (!m) return NaN;
	const n = parseFloat(m[1]);
	return Math.round(n * (m[2] === 'B' ? 1 : m[2] === 'KB' ? 1024 : 1048576));
};
check(
	'displayed processed size matches real downloaded bytes',
	Math.abs(toBytes(sizes[1]) - out.length) < 1536,
	`${sizes[1]} vs ${out.length}`
);
check('savings reported', /Saved/.test((await page.textContent('.verdict')) ?? ''), await page.textContent('.verdict'));

// --- the lazy codec actually works from the CDN ------------------------------
// A wrong MIME type, a broken cache rule, or a wasm-cache interceptor scoped by
// extension instead of URL would all pass every local test and still leave the
// lossy modes doing nothing in production. This is the only place that is
// caught.
const photo = new Uint8Array(await readFile(path.join(here, '..', 'fixtures', 'photo-q90.pdf')));

await page.click('button.secondary:has-text("Compress another")');
await page.setInputFiles('input[type=file]', {
	name: 'live-photo.pdf',
	mimeType: 'application/pdf',
	buffer: Buffer.from(photo)
});
await page.waitForSelector('button.primary:has-text("Compress PDF")', { timeout: 120_000 });
await page.waitForSelector('.panel[data-stage="idle"]', { timeout: 120_000 });

const wasmSeen = [];
page.on('response', async (r) => {
	if (r.url().endsWith('.wasm')) {
		wasmSeen.push({ url: r.url().split('/').pop(), type: r.headers()['content-type'] });
	}
});

await page.click('.chip:has-text("Maximum")');
await page.click('button.primary:has-text("Compress PDF")');
await page.waitForSelector('.result', { timeout: 240_000 });

check('codec wasm served with application/wasm', wasmSeen.length > 1 && wasmSeen.every((w) => /application\/wasm/.test(w.type)), JSON.stringify(wasmSeen));
check('more than one wasm fetched (QPDF + codec)', new Set(wasmSeen.map((w) => w.url)).size > 1, JSON.stringify(wasmSeen.map((w) => w.url)));

const photos = await page.$$eval('.sizes dd', (ds) => ds.map((d) => d.textContent?.trim() ?? ''));
const reportRows = await page.$$eval('.report li', (ls) =>
	ls.map((li) => ({
		key: li.querySelector('.report-key')?.textContent?.trim(),
		value: li.querySelector('.report-val')?.textContent?.trim()
	}))
);
const imagesRow = reportRows.find((r) => r.key === 'Images')?.value ?? '';
check('live lossy mode reports re-encoding images', /re-encoded/.test(imagesRow), imagesRow);
check('live lossy mode actually shrank the photo', toBytes(photos[1]) < photo.length, `${photos[1]} vs ${photo.length}`);

// --- privacy: nothing but same-origin static assets ------------------------
const offenders = requests.filter((u) => {
	const p = new URL(u);
	if (p.origin !== new URL(BASE).origin) return true;
	return !/^\/(?:_app\/.*|favicon\.svg|index\.html)?$/.test(p.pathname);
});
check('no document bytes leave the browser (live)', offenders.length === 0, offenders.join(', '));
check('no page errors', errors.length === 0, errors.join('\n'));

await browser.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
	console.log('\nFailures:');
	failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(failed ? 1 : 0);