/**
 * Mobile viewport verification, in every engine.
 *
 * WHY THIS EXISTS
 *
 * `test:browser` proves the app works, but it proves it at a desktop viewport.
 * This is a drag-and-drop upload interface, and a phone is the most likely place
 * a layout defect hides: a control that falls below the fold, a result table
 * wider than the screen, a tap target too small to hit reliably. None of those
 * fail a desktop run and all of them are real usability faults.
 *
 * The file input is also the upload path a phone actually uses - there is no
 * drag and drop on a touchscreen - so this suite exercises the genuine mobile
 * route rather than simulating a desktop one.
 *
 * WHAT IS ASSERTED
 *
 * Real, measurable properties: no horizontal overflow, tap targets at or above
 * the 44 px WCAG minimum, the primary action reachable and operable, and a
 * complete upload through to a downloadable result.
 *
 * WHAT IS NOT CLAIMED
 *
 * This is not a device lab. It is a set of viewports, not real hardware: no
 * touch physics, no mobile Safari, no Android Chrome, no throttled CPU or slow
 * network. Real-device testing remains outstanding, and is named as such in the
 * README rather than implied away by this suite passing.
 *
 * Run: bun scripts/test/test-mobile.mjs
 *      bun scripts/test/test-mobile.mjs -- webkit
 */
import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/* Viewports chosen to cover the shapes that break: a narrow Android phone, a
 * modern iPhone, and a deliberately small window to catch text that only fits on
 * a wide screen. */
const VIEWPORTS = [
	{ id: 'android-360', width: 360, height: 740, label: 'small Android' },
	{ id: 'iphone-390', width: 390, height: 844, label: 'iPhone-class' },
	{ id: 'tiny-320', width: 320, height: 568, label: 'deliberately small' }
];

const ENGINES = [
	['chromium', chromium, { channel: 'chromium' }],
	['firefox', firefox, {}],
	['webkit', webkit, {}]
];

let passed = 0;
let failed = 0;
const failures = [];
let currentEngine = 'chromium';
let currentViewport = 'android-360';

function check(name, condition, detail = '') {
	const label = `${currentEngine}/${currentViewport}: ${name}`;
	if (condition) {
		passed++;
		console.log(`  PASS  ${label}`);
	} else {
		failed++;
		failures.push(`${label}${detail ? ` :: ${detail}` : ''}`);
		console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
	}
}

/** Horizontal overflow in CSS pixels. 0 when the page fits. */
const overflowOf = (page) =>
	page.evaluate(() => {
		const doc = document.documentElement;
		return Math.max(0, doc.scrollWidth - doc.clientWidth);
	});

/** Bounding boxes of elements that stick out past the viewport on the right. */
const wideElements = (page) =>
	page.evaluate(() => {
		const limit = document.documentElement.clientWidth + 1;
		const out = [];
		for (const el of document.querySelectorAll('body *')) {
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			if (r.right > limit) {
				const id =
					el.tagName.toLowerCase() +
					(el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).join('.')}` : '');
				out.push(`${id} right=${Math.round(r.right)}`);
			}
			if (out.length >= 5) break;
		}
		return out;
	});

async function newMobilePage(browser, viewport) {
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		isMobile: true,
		hasTouch: true,
		deviceScaleFactor: 2
	});
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e).split('\n')[0].slice(0, 120)));
	return { context, page, errors };
}

const { server, port } = await serve();
const photo = new Uint8Array(await readFile(path.join(here, '..', 'fixtures', 'photo-q90.pdf')));

const only = process.argv.slice(2).map((a) => a.replace(/^--/, '')).filter(Boolean);
const engines = only.length ? ENGINES.filter(([n]) => only.includes(n)) : ENGINES;
if (only.length && engines.length !== only.length) {
	console.error(`unknown engine: ${only.filter((n) => !ENGINES.some(([e]) => e === n)).join(', ')}`);
	process.exit(2);
}

for (const [engineName, engine, options] of engines) {
	currentEngine = engineName;
	console.log(`\n${'='.repeat(72)}`);
	console.log(`Mobile viewport verification — ${engineName}`);
	console.log(`${'='.repeat(72)}`);

	let browser;
	try {
		browser = await engine.launch(options);
	} catch (err) {
		failed++;
		failures.push(`${engineName}: launch failed — ${String(err.message).split('\n')[0]}`);
		console.log(`  FAIL  ${engineName}: launch failed`);
		continue;
	}

	for (const viewport of VIEWPORTS) {
		currentViewport = viewport.id;
		console.log(`\n  [${viewport.id}] ${viewport.width}x${viewport.height} (${viewport.label})\n`);

		const { context, page, errors } = await newMobilePage(browser, viewport);
		try {
			await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 45_000 });
			await page.waitForSelector('.drop-title', { timeout: 45_000 });

			check('the app mounts at this viewport', true);

			/* The defect this suite exists to catch. */
			const overflow = await overflowOf(page);
			const wide = await wideElements(page);
			check(
				'no horizontal overflow',
				overflow === 0,
				`${overflow}px past the viewport${wide.length ? ` — widest: ${wide.join(', ')}` : ''}`
			);

			/* WCAG 2.5.5 minimum, and the control a phone user actually needs. */
			const dropBox = await page.locator('.drop').boundingBox().catch(() => null);
			check(
				'the drop area is a usable tap target',
				dropBox !== null && dropBox.height >= 44,
				dropBox ? `height ${Math.round(dropBox.height)}px` : 'no .drop element'
			);

			/* The upload route a phone uses: the file input, not drag and drop. */
			await page.setInputFiles('input[type=file]', {
				name: 'photo.pdf',
				mimeType: 'application/pdf',
				buffer: Buffer.from(photo)
			});
			await page.waitForSelector('button.primary:has-text("Compress PDF")', { timeout: 120_000 });
			await page.waitForSelector('.panel[data-stage="idle"]', { timeout: 120_000 });

			check(
				'no overflow once the options panel is open',
				(await overflowOf(page)) === 0,
				`${await overflowOf(page)}px`
			);

			const cta = await page.locator('button.primary:has-text("Compress PDF")').boundingBox();
			check(
				'the primary action is a usable tap target',
				cta !== null && cta.height >= 44 && cta.width >= 44,
				cta ? `${Math.round(cta.width)}x${Math.round(cta.height)}` : 'not found'
			);

			/* The mode chips are touch targets too, and picking a mode is a step a
			 * phone user has to make. The first run of this suite found the primary
			 * button at 39 px in all nine combinations and did not look here at all. */
			const chips = await page.locator('.chip').all();
			let smallestChip = Infinity;
			for (const chip of chips) {
				const box = await chip.boundingBox();
				if (box) smallestChip = Math.min(smallestChip, box.height);
			}
			check(
				'every mode chip is a usable tap target',
				chips.length === 3 && smallestChip >= 44,
				chips.length === 3 ? `smallest ${Math.round(smallestChip)}px` : `found ${chips.length} chips`
			);

			await page.click('button.primary:has-text("Compress PDF")');
			await page.waitForSelector('.result, .error', { timeout: 180_000 });

			const outcome = await page.evaluate(() => ({
				error: document.querySelector('.error')?.textContent?.trim().slice(0, 120) ?? null,
				download: !!document.querySelector('a.primary[download]')
			}));
			check('a phone upload completes to a result', outcome.error === null, outcome.error ?? '');
			check('the download is offered', outcome.download);

			/* The last thing a phone user touches. */
			const download = await page.locator('a.primary[download]').boundingBox().catch(() => null);
			check(
				'the download action is a usable tap target',
				download !== null && download.height >= 44,
				download ? `${Math.round(download.width)}x${Math.round(download.height)}` : 'not found'
			);

			check(
				'no overflow on the result panel',
				(await overflowOf(page)) === 0,
				`${await overflowOf(page)}px`
			);

			check('no page errors', errors.length === 0, errors.join('\n'));
		} catch (err) {
			failed++;
			failures.push(
				`${engineName}/${viewport.id}: aborted — ${String(err.message).split('\n')[0].slice(0, 110)}`
			);
			console.log(`  FAIL  ${engineName}/${viewport.id}: aborted — ${String(err.message).split('\n')[0].slice(0, 90)}`);
		} finally {
			await context.close();
		}
	}

	await browser.close();
}

server.close();

console.log(`\n${'='.repeat(72)}`);
console.log(`${passed} passed, ${failed} failed across ${engines.length} engine(s) x ${VIEWPORTS.length} viewports`);
if (failures.length) {
	console.log('\nFailures:');
	for (const f of failures) console.log(`  - ${f}`);
}
console.log('');

process.exit(failed ? 1 : 0);