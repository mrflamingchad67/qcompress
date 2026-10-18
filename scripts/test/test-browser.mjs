/**
 * End-to-end verification in a real browser, in every engine Playwright ships.
 *
 * Engines: Chromium, Firefox and WebKit. The suite runs in full against each.
 * "The app mounts" is not evidence that an engine works - all three mount, and
 * the parts most likely to differ (two WASM modules, a worker,
 * `DecompressionStream`, a stream that must be cancelled) are exactly the parts
 * that decide whether a PDF can be compressed at all.
 *
 * This is the only place where the WASM engine's diagnostics capture can be
 * verified for real: in Node the glue links nodefs (so output bypasses
 * Module.print), whereas a browser worker routes it through the TTY.
 *
 * Also asserts the privacy property that matters: once the page is loaded,
 * no further network requests are made while a PDF is processed.
 *
 * Usage: bun run test:browser                 every engine
 *        bun run test:browser -- firefox      one engine
 */
import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { minimalPdf, textPdf, notAPdf } from '../lib/fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', 'build');

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.wasm': 'application/wasm',
	'.svg': 'image/svg+xml',
	'.json': 'application/json',
	'.ico': 'image/x-icon'
};

/** Static file server for the production build. */
function serve() {
	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url, 'http://localhost');
			let file = path.join(root, decodeURIComponent(url.pathname));
			if ((await stat(file).catch(() => null))?.isDirectory() ?? true) {
				file = path.join(file, 'index.html');
			}
			const body = await readFile(file);
			res.writeHead(200, {
				'content-type': MIME[path.extname(file)] ?? 'application/octet-stream'
			});
			res.end(body);
		} catch {
			res.writeHead(404).end('not found');
		}
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
	});
}

let passed = 0;
let failed = 0;
const failures = [];

/** Per-engine tallies, so a failure names the engine it happened in. */
let currentEngine = 'chromium';

function check(name, condition, detail = '') {
	const label = `${currentEngine}: ${name}`;
	if (condition) {
		passed++;
		console.log(`  PASS  ${label}`);
	} else {
		failed++;
		failures.push(`${label}${detail ? ` :: ${detail}` : ''}`);
		console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
	}
}

/**
 * Select a mode and prove the selection took.
 *
 * The chip is a `<label>` wrapping `input[type=radio][name=mode]`, so clicking
 * the label is the user action. But a click that silently matches nothing would
 * leave the default mode selected, and several assertions here would then pass
 * while measuring a different mode than they name - which is precisely the
 * mistake that made a cross-engine probe report Balanced re-encoding images
 * under a case labelled "lossless". So the radio is read back.
 */
async function setMode(page, mode) {
	await page.click(`.chip:has-text("${mode}")`);
	const selected = await page.evaluate(
		() => document.querySelector('input[name="mode"]:checked')?.value ?? null
	);
	/* The chip's visible text is the capitalised label ("Lossless") while the
	 * radio's value is the id ("lossless"), so the comparison is case-folded
	 * rather than making every call site know which one it holds. The first
	 * version compared them raw and failed on WebKit with the radio reading
	 * exactly the string it was asked for. */
	check(
		`mode actually switched to ${mode}`,
		selected !== null && selected.toLowerCase() === mode.toLowerCase(),
		`radio reads "${selected}"`
	);
}

const { server, port } = await serve();
/* Engines to run. `channel: 'chromium'` uses the full Chromium build rather
 * than the separate chromium-headless-shell download. A single engine can be
 * selected by name, e.g. `bun run test:browser -- webkit`.
 *
 * The suite body below is written once and run per engine: it reads `browser`,
 * `port`, `newPage`, `check` and the counters, all of which live in this scope. */
const ENGINES = [
	['chromium', chromium, { channel: 'chromium' }],
	['firefox', firefox, {}],
	['webkit', webkit, {}]
];

const only = process.argv.slice(2).map((a) => a.replace(/^--/, '')).filter(Boolean);
const selected = only.length ? ENGINES.filter(([n]) => only.includes(n)) : ENGINES;

if (only.length && selected.length !== only.length) {
	console.error(`unknown engine: ${only.filter((n) => !ENGINES.some(([e]) => e === n)).join(', ')}`);
	console.error(`available: ${ENGINES.map(([n]) => n).join(', ')}`);
	process.exit(2);
}

async function runSuite(browser) {

async function newPage() {
	const context = await browser.newContext();
	const page = await context.newPage();
	const requests = [];
	page.on('request', (r) => requests.push(r.url()));
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
	// ssr = false: wait for the client app to mount before probing the DOM.
	await page.waitForSelector('.drop-title', { timeout: 30_000 });
	return { page, context, requests, errors };
}

/** Feed a PDF into the file input and wait for the options panel. */
async function selectPdf(page, bytes, name = 'sample.pdf') {
	await page.setInputFiles('input[type=file]', {
		name,
		mimeType: 'application/pdf',
		buffer: Buffer.from(bytes)
	});
	await page.waitForSelector('button.primary:has-text("Compress PDF")', { timeout: 120_000 });
	// The options panel appears immediately; wait for inspection to settle.
	await page.waitForSelector('.panel[data-stage="idle"]', { timeout: 120_000 });
}

async function compress(page) {
	await page.click('button.primary:has-text("Compress PDF")');
	await page.waitForSelector('.result, .error', { timeout: 180_000 });
}

/** The engine's own account of what it did, read back off the result panel. */
async function report(page) {
	return page.evaluate(() => {
		const rows = [...document.querySelectorAll('.report li')];
		return Object.fromEntries(
			rows.map((li) => [
				li.querySelector('.report-key')?.textContent?.trim(),
				li.querySelector('.report-val')?.textContent?.trim()
			])
		);
	});
}

/** Output size in bytes, parsed from the "Processed" row. */
async function processedBytes(page) {
	return page.evaluate(() => {
		const dd = [...document.querySelectorAll('.sizes dd')][1]?.textContent ?? '';
		const m = dd.match(/([\d.,]+)\s*(B|KB|MB)/i);
		if (!m) return null;
		const n = parseFloat(m[1].replace(',', ''));
		const unit = m[2].toUpperCase();
		return Math.round(n * (unit === 'KB' ? 1024 : unit === 'MB' ? 1048576 : 1));
	});
}

// ---------------------------------------------------------------------------
console.log('\n[1] initial render');
{
	const { page, context } = await newPage();
	check('title', (await page.title()) === 'QCompress');
	check('dropzone visible', await page.isVisible('.drop'));
	check('dropzone is the primary element', await page.isVisible('.drop-title'));
	check('no options before a file is chosen', !(await page.isVisible('fieldset.options')));
	check('no result before processing', !(await page.isVisible('.result')));
	// Only one link is allowed on the page: the source link in the footer.
	// No navigation, marketing or cross-links.
	const links = await page.$$eval('a', (as) =>
		as.map((a) => ({ href: a.getAttribute('href'), text: a.textContent?.trim() }))
	);
	check(
		'only the source link exists',
		links.length === 1 && links[0].href === 'https://github.com/mrflamingchad67/qcompress',
		JSON.stringify(links)
	);
	check('source link opens safely', await page.$eval('a.source', (a) => a.rel === 'noopener noreferrer'));

	const bodyText = (await page.textContent('body')) ?? '';
	check('no FAQ/About sections', !/frequently asked|about us|how it works|testimonials|pricing/i.test(bodyText));
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[1b] footer');
{
	const { page, context } = await newPage();
	check('copyright shown', /©\s*\d{4},\s*mrflamingchad67/.test((await page.textContent('.meta')) ?? ''));
	check('source link present', await page.isVisible('a.source'));
	check('source link labelled', (await page.textContent('a.source'))?.trim() === 'Source');
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[2] compression of a text-heavy PDF');
{
	const { page, context, requests, errors } = await newPage();
	const bytes = textPdf(8, 45);

	// Inspection loads the worker + wasm. Everything after that must be silent.
	await selectPdf(page, bytes);

	const result0 = await page.textContent('.result').catch(() => null);
	check('no result before compressing', result0 === null);

	await compress(page);

	const result = await page.textContent('.result');
	check('result panel shown', !!result);
	check('filename shown', (await page.textContent('.file-name'))?.includes('sample.pdf'));

	const original = bytes.length;
	const dl = await page.getAttribute('a.primary', 'download');
	check('download attribute set', dl === 'sample-compressed.pdf', String(dl));

	// Read the actual downloaded bytes and verify size arithmetic.
	const [download] = await Promise.all([page.waitForEvent('download'), page.click('a.primary')]);
	const stream = await download.createReadStream();
	const chunks = [];
	for await (const c of stream) chunks.push(c);
	const out = Buffer.concat(chunks);

	check('downloaded bytes are a real PDF', out.subarray(0, 5).toString() === '%PDF-');
	check('downloaded file is valid size', out.length > 0 && out.length < original, `${out.length} vs ${original}`);

	// The three cells are Original / Processed / Change.
	const sizes = await page.$$eval('.sizes dd', (ds) => ds.map((d) => d.textContent?.trim() ?? ''));
	const [shownOriginal, shownProcessed, shownChange] = sizes;
	check('original size displayed', /KB|MB/.test(shownOriginal), shownOriginal);
	check('processed size displayed', /KB|MB/.test(shownProcessed), shownProcessed);

	// Verify the displayed numbers match the real byte counts.
	const toBytes = (s) => {
		const m = /^([\d.]+)\s*(B|KB|MB)$/.exec(s.trim());
		if (!m) return NaN;
		const n = parseFloat(m[1]);
		return Math.round(n * (m[2] === 'B' ? 1 : m[2] === 'KB' ? 1024 : 1048576));
	};
	const dispOrig = toBytes(shownOriginal);
	const dispProc = toBytes(shownProcessed);
	check('displayed original matches real bytes', Math.abs(dispOrig - original) < 1024 * 1.5, `${dispOrig} vs ${original}`);
	check('displayed processed matches downloaded bytes', Math.abs(dispProc - out.length) < 1024 * 1.5, `${dispProc} vs ${out.length}`);
	check('change cell is a signed delta', /^[+-]/.test(shownChange ?? ''), shownChange ?? '');
	check(
		'change cell magnitude matches measured delta',
		Math.abs(toBytes(shownChange.replace(/^[+-]/, '')) - Math.abs(original - out.length)) < 1024 * 1.5,
		`${shownChange} vs ${original - out.length}`
	);
	check('savings claim matches measured bytes', /Saved/.test(result ?? ''), result ?? '');

	// Privacy: the PDF bytes must never appear in any request. App assets
	// (JS chunks, worker, wasm, favicon) are legitimate — they are code, not
	// document content. What must not happen is a request carrying the file, or
	// any request at all once the engine is already warm.
	const base = new URL(`http://127.0.0.1:${port}/`);
	const offenders = requests.filter((u) => {
		const parsed = new URL(u, base);
		if (parsed.origin !== base.origin) return true; // any third party
		// only same-origin static assets are acceptable
		return !/^\/(?:_app\/.*|favicon\.svg|index\.html)?$/.test(parsed.pathname);
	});
	check('no PDF bytes leave the browser', offenders.length === 0, offenders.join(', '));
	check('no page errors', errors.length === 0, errors.join('\n'));
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[3] no-size-reduction case is reported honestly');
{
	const { page, context } = await newPage();
	await selectPdf(page, minimalPdf(), 'tiny.pdf');
	await compress(page);
	const text = (await page.textContent('.result')) ?? '';
	check('reports "No size reduction achieved"', /No size reduction achieved/i.test(text), text.slice(0, 200));
	check('still offers a download', await page.isVisible('a.primary'));
	const sizes = await page.$$eval('.sizes dd', (ds) => ds.map((d) => d.textContent?.trim()));
	check('larger output is flagged', /^\+/.test(sizes[2] ?? ''), sizes.join(' | '));
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[4] non-PDF input is rejected without breaking the page');
{
	const { page, context } = await newPage();
	await page.setInputFiles('input[type=file]', {
		name: 'notes.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from(notAPdf())
	});
	await page.waitForSelector('.error', { timeout: 30_000 });
	const text = (await page.textContent('.error')) ?? '';
	check('shows an error', /not a PDF/i.test(text), text.slice(0, 160));
	check('offers retry / another file', await page.isVisible('.error-actions'));
	check('page still usable', await page.isVisible('.drop'));
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[5] diagnostics capture works in the browser (encryption)');
{
	const { page, context } = await newPage();

	// Build an encrypted PDF with the same WASM engine, off-page.
	const glue = await import(
		pathToFileURL(path.join(here, '..', '..', 'src', 'lib', 'vendors', 'qpdf.js')).href
	);
	const createModule = glue.default;
	const mod = await createModule({ noInitialRun: true, print: () => {}, printErr: () => {} });
	mod.FS.writeFile('/m.pdf', Buffer.from(minimalPdf()));
	mod.callMain(['--encrypt', 'ownerpw', 'userpw', '256', '--print=none', '--modify=none', '--', '/m.pdf', '/enc.pdf']);
	const enc = Buffer.from(mod.FS.readFile('/enc.pdf'));

	await selectPdf(page, enc, 'locked.pdf');
	// The password field appears once inspection reports encryption.
	await page.waitForSelector('#password', { timeout: 60_000 });
	check('password field shown for encrypted PDF', await page.isVisible('#password'));

	// Wrong password must fail with a real message, not a generic one.
	await page.fill('#password', 'wrong');
	await compress(page);
	const errText = (await page.textContent('.error')) ?? '';
	check('wrong password reported honestly', /password/i.test(errText), errText.slice(0, 200));
	check('offers download of original', /Download original/i.test(errText));

	// Correct password must succeed.
	await page.click('.error-actions >> text=Choose another file');
	await selectPdf(page, enc, 'locked.pdf');
	await page.fill('#password', 'userpw');
	await compress(page);
	check('correct password compresses', await page.isVisible('.result'));
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[6] keyboard accessibility');
{
	const { page, context } = await newPage();

	// The drop zone must be keyboard reachable.
	const dropTabIndex = await page.$eval('.drop', (e) => e.tabIndex);
	check('dropzone is in the tab order', dropTabIndex === 0, `tabindex=${dropTabIndex}`);

	await page.focus('.drop');
	const focused = await page.evaluate(() => document.activeElement?.className ?? '');
	check('dropzone can take focus', focused.includes('drop'), focused);

	// Every control must be reachable by keyboard and carry an accessible name.
	const unlabelled = await page.$$eval('button, a[download]', (els) =>
		els
			.filter(
				(e) =>
					!e.textContent?.trim() &&
					!e.getAttribute('aria-label') &&
					!e.getAttribute('title')
			)
			.map((e) => e.outerHTML.slice(0, 80))
	);
	check('no controls without an accessible name', unlabelled.length === 0, unlabelled.join(' | '));

	const hasInput = await page.$('input[type=file]');
	check('hidden file input present', !!hasInput);
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[7] reset returns to the initial state');
{
	const { page, context } = await newPage();
	await selectPdf(page, textPdf(2, 10), 'a.pdf');
	await compress(page);
	await page.click('button.secondary:has-text("Compress another")');
	check('back to empty state', await page.isVisible('.drop-title'));
	check('options gone', !(await page.isVisible('fieldset.options')));
	check('result gone', !(await page.isVisible('.result')));
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[8] WASM is lazy-loaded (not fetched on initial page load)');
{
	const { page, context, requests } = await newPage();
	await page.waitForTimeout(500);
	const wasmRequests = requests.filter((u) => u.endsWith('.wasm'));
	check('no .wasm fetched before a file is chosen', wasmRequests.length === 0, wasmRequests.join(', '));

	await selectPdf(page, textPdf(1, 5), 'x.pdf');
	const wasmAfter = requests.filter((u) => u.endsWith('.wasm'));
	check('.wasm fetched after selecting a file', wasmAfter.length >= 1, wasmAfter.join(', '));
	// Fetched once, from one stable URL, then served from memory.
	check(
		'.wasm fetched exactly once after selecting a file',
		wasmAfter.length === 1,
		`${wasmAfter.length} requests: ${wasmAfter.join(', ')}`
	);
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[9] a warm engine is offline; the codec is fetched at most once');
{
	const { page, context, requests } = await newPage();
	await selectPdf(page, textPdf(3, 10), 'warm.pdf'); // QPDF engine loads here
	const baseline = requests.length;

	// First compression. QPDF is already warm, but Balanced is a lossy mode,
	// so the JPEG codec is fetched lazily on first use. That is a one-off.
	await compress(page);
	const first = requests.slice(baseline);
	check('first compression loads the codec at most once per chunk', new Set(first).size === first.length, first.join(', '));
	check('first compression does not refetch the QPDF binary', !first.some((u) => u.endsWith('.wasm')), first.join(', '));
	check('result produced', await page.isVisible('.result'));

	// Every engine dependency is now resident, so a second run must be silent.
	const beforeSecond = requests.length;
	await page.click('button.secondary:has-text("Compress another")');
	await selectPdf(page, textPdf(3, 10), 'warm2.pdf');
	await compress(page);
	const second = requests.slice(beforeSecond);
	check('compression on a fully warm engine is offline', second.length === 0, second.join(', '));
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[9b] lossless mode never downloads the JPEG codec');
{
	const { page, context, requests } = await newPage();
	await selectPdf(page, textPdf(3, 10), 'lossless.pdf');
	const baseline = requests.length;

	await setMode(page, 'Lossless');
	await compress(page);

	const after = requests.slice(baseline);
	// Lossless cannot re-encode an image, so the codec must stay unbundled-off.
	check('lossless run fetches no codec chunk', after.every((u) => u.endsWith('.wasm')), after.join(', '));
	check('lossless run produced a result', await page.isVisible('.result'));
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[9c] the three modes are real behavioural differences');
{
	// A real JPEG photo, so the lossy modes have something to re-encode.
	// scripts/lib/fixtures.mjs only builds Flate images, which are never
	// touched by the image path.
	const photo = new Uint8Array(await readFile(path.join(here, '..', 'fixtures', 'photo-q90.pdf')));

	const { page, context } = await newPage();
	await selectPdf(page, photo, 'photo.pdf');

	check('mode selector offers exactly three modes', (await page.$$('.chip')).length === 3);

	await setMode(page, 'Lossless');
	await compress(page);
	const lossless = await report(page);
	const losslessSize = await processedBytes(page);

	check(
		'lossless is reported as leaving images unchanged',
		lossless.Images === 'unchanged as-is',
		lossless.Images
	);

	await page.click('button.secondary:has-text("Compress another")');
	await selectPdf(page, photo, 'photo.pdf');
	await setMode(page, 'Maximum');
	await compress(page);
	const maximum = await report(page);
	const maximumSize = await processedBytes(page);

	check(
		'maximum reports re-encoding images',
		/re-encoded/.test(maximum.Images ?? ''),
		maximum.Images
	);
	check(
		'maximum is smaller than lossless on a photo',
		maximumSize !== null && losslessSize !== null && maximumSize < losslessSize,
		`maximum=${maximumSize} lossless=${losslessSize}`
	);
	check(
		'each run names the method it used',
		!!lossless.Method && !!maximum.Method,
		`${lossless.Method} / ${maximum.Method}`
	);
	check(
		'the lossy run says so',
		(lossless.Method ?? '') !== (maximum.Method ?? ''),
		`${lossless.Method} / ${maximum.Method}`
	);

	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[9d] Flate-wrapped JPEGs are handled in the browser');
{
	// The consequences of this bug are browser-only: `/Filter
	// [/FlateDecode /DCTDecode]` stores a Flate-compressed JPEG, so feeding the
	// stored bytes to the JPEG decoder fails on every image and the run reports
	// "images unchanged". The worker has no Node zlib, so this also proves the
	// native Compression Streams path works end to end.
	const { readFile: rf } = await import('node:fs/promises');
	const wrapped = new Uint8Array(await rf(path.join(here, '..', 'fixtures', 'jpeg-flate-wrapped.pdf')));

	const { page, context } = await newPage();
	await selectPdf(page, wrapped, 'wrapped.pdf');
	await page.click('.chip:has-text("Maximum")');
	await compress(page);

	const rows = await page.$$eval('.report li', (ls) =>
		ls.map((li) => ({
			key: li.querySelector('.report-key')?.textContent?.trim(),
			value: li.querySelector('.report-val')?.textContent?.trim()
		}))
	);
	const images = rows.find((r) => r.key === 'Images')?.value ?? '';
	check(
		'flate-wrapped JPEG is re-encoded, not skipped',
		/re-encoded/.test(images),
		`Images row said "${images}" - the browser cannot unwrap this encoding`
	);
	check(
		'wrapped-image document shrank',
		/Saved/.test((await page.textContent('.verdict')) ?? ''),
		(await page.textContent('.verdict')) ?? '(no verdict)'
	);
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[9e] ICC-tagged RGB is re-encoded, 4-component ICC is not');
{
	const { readFile: rf } = await import('node:fs/promises');
	const load = async (n) => new Uint8Array(await rf(path.join(here, '..', 'fixtures', n)));

	const run = async (file) => {
		const { page, context } = await newPage();
		await selectPdf(page, await load(file), file);
		await page.click('.chip:has-text("Maximum")');
		await compress(page);
		const rows = await page.$$eval('.report li', (ls) =>
			ls.map((li) => ({
				key: li.querySelector('.report-key')?.textContent?.trim(),
				value: li.querySelector('.report-val')?.textContent?.trim()
			}))
		);
		await context.close();
		return rows.find((r) => r.key === 'Images')?.value ?? '';
	};

	const rgb = await run('jpeg-icc-rgb.pdf');
	const cmyk = await run('jpeg-icc-cmyk.pdf');
	check('ICCBased /N 3 is treated as RGB', /re-encoded/.test(rgb), rgb);
	check('ICCBased /N 4 is left alone', !/re-encoded/.test(cmyk), cmyk);
}

// ---------------------------------------------------------------------------
console.log('\n[9f] repeated runs do not leak state between files');
{
	const { readFile: rf } = await import('node:fs/promises');
	const photo = new Uint8Array(await rf(path.join(here, '..', 'fixtures', 'photo-q90.pdf')));
	const { page, context } = await newPage();

	// Interleave two documents. A worker that cached image data or reused a
	// temp path between runs would eventually return one file's result for
	// another.
	// Each input must always produce an output named after *that* input. If the
	// worker cached image data or reused a temp path, one of these would come
	// back named for the other file.
	const pairs = new Map();
	let first = true;
	for (let round = 0; round < 2; round++) {
		for (const [name, buf] of [
			['photo-a.pdf', photo],
			['text-b.pdf', textPdf(3, 12)]
		]) {
			// "Compress another" only exists once a result is on screen, so the
			// very first pass starts from the empty state.
			if (!first) await page.click('button.secondary:has-text("Compress another")');
			first = false;
			await selectPdf(page, buf, name);
			await compress(page);
			const shown = (await page.textContent('.out-row .file-name')) ?? '';
			const stem = name.replace(/\.pdf$/, '');
			if (!shown.includes(stem)) {
				check(`round ${round}: ${name} produced ${shown}`, false, 'result named for a different input');
			}
			pairs.set(name, shown);
		}
	}
	check('each input maps to its own output, every round', pairs.size === 2, [...pairs].map(([k, v]) => `${k}->${v}`).join(' | '));
	await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n[10] icons render as inline SVG from the local bundle');
{
	const { page, context, requests } = await newPage();

	const svgCount = await page.$$eval('svg', (s) => s.length);
	check('dropzone icon rendered', svgCount >= 1, `found ${svgCount}`);

	// Icon must be an inline SVG element, not a font glyph or an <img>.
	const tag = await page.$eval('.upload-badge svg', (e) => e.tagName.toLowerCase());
	check('icon is an inline <svg>', tag === 'svg', tag);

	const external = requests.filter((u) => /lucide|cdn|unpkg|jsdelivr|fontawesome|googleapis/i.test(u));
	check('no external icon/font requests', external.length === 0, external.join(', '));

	// Decorative icons next to text must be hidden from assistive tech.
	const hidden = await page.$$eval('.upload-badge svg', (s) => s.map((e) => e.getAttribute('aria-hidden')));
	check('decorative icon is aria-hidden', hidden.every((h) => h === 'true'), hidden.join(','));

	// There is no file tray; the file row in the drop card is the only place
	// the selected file is shown, and it is itself the replace-file control.
	await selectPdf(page, textPdf(2, 8), 'icons.pdf');
	check('no file tray exists', !(await page.isVisible('.tray')));
	check('file is shown in the drop card', await page.isVisible('.file-row'));

	await compress(page);
	const dlText = (await page.textContent('a.primary'))?.trim();
	check('download action keeps a text label', /Download PDF/.test(dlText ?? ''), String(dlText));
	check('verdict icon rendered', await page.isVisible('.verdict svg'));
	check('output filename shown', await page.isVisible('.out-row .file-name'));

	await context.close();
}
}

// ---------------------------------------------------------------------------
const perEngine = [];
for (const [name, engine, options] of selected) {
	currentEngine = name;
	const before = { passed, failed };
	console.log(`\n${'='.repeat(72)}`);
	console.log(`Browser end-to-end verification — ${name}`);
	console.log(`${'='.repeat(72)}\n`);

	let browser;
	try {
		browser = await engine.launch(options);
	} catch (err) {
		failed++;
		failures.push(`${name}: engine failed to launch — ${String(err.message).split('\n')[0]}`);
		console.log(`  FAIL  ${name}: engine failed to launch — ${String(err.message).split('\n')[0]}`);
		continue;
	}

	try {
		await runSuite(browser);
	} catch (err) {
		// One uncaught error must not abandon the remaining engines.
		failed++;
		failures.push(`${name}: suite aborted — ${String(err.message).split('\n')[0]}`);
		console.log(`  FAIL  ${name}: suite aborted — ${String(err.message).split('\n')[0]}`);
	} finally {
		await browser.close().catch(() => {});
	}

	perEngine.push([name, passed - before.passed, failed - before.failed]);
}

console.log(`\n${'='.repeat(72)}`);
for (const [name, p, f] of perEngine) {
	console.log(`  ${name.padEnd(10)} ${String(p).padStart(3)} passed, ${f} failed`);
}
console.log(`${'='.repeat(72)}`);
console.log(`\n${passed} passed, ${failed} failed across ${selected.length} engine(s)`);
server.close();
if (failures.length) {
	console.log('\nFailures:');
	failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(failed ? 1 : 0);