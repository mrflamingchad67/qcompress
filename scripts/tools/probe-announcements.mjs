/**
 * P11 probe: do the announcement regions actually announce anything?
 *
 * WHY A PROBE AND NOT A SUITE
 *
 * The interface already carries `role="status" aria-live="polite"` on the
 * progress panel and `role="alert"` on the error panel. Neither is asserted
 * anywhere, and an attribute is not a behaviour: a live region whose text never
 * changes announces nothing, and an alert that is present but empty announces
 * nothing. Both would pass any check that only looked at the markup.
 *
 * So this observes what a screen reader would actually be told: whether the
 * progress region's text CHANGES while a document is being processed, and
 * whether the error region is populated when a document is rejected.
 *
 * It reports, it does not assert - the same contract as the two engine probes.
 *
 * Run: bun scripts/tools/probe-announcements.mjs
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, firefox, webkit } from 'playwright';
import { notAPdf } from '../lib/fixtures.mjs';

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
const photo = new Uint8Array(await readFile(path.join(here, '..', 'fixtures', 'photo-q90.pdf')));

const ENGINES = [
	['chromium', chromium, { channel: 'chromium' }],
	['firefox', firefox, {}],
	['webkit', webkit, {}]
];

/** Everything a live region would announce, as a screen reader sees it. */
const liveText = (page, selector) =>
	page.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const role = el.getAttribute('role');
		const live = el.getAttribute('aria-live');
		const busy = el.getAttribute('aria-busy');
		// InnerText, not textContent: aria-live announces rendered text, and a
		// visually-hidden node is still announced, so this is the right measure.
		return { role, live, busy, text: (el.innerText ?? '').replace(/\s+/g, ' ').trim() };
	}, selector);

process.stdout.write('\n');
process.stdout.write('  What a screen reader would be told, per engine\n');
process.stdout.write(`  ${'-'.repeat(74)}\n`);

for (const [name, engine, options] of ENGINES) {
	let browser;
	try {
		browser = await engine.launch(options);
	} catch (err) {
		process.stdout.write(`\n  ${name}: LAUNCH FAILED\n`);
		continue;
	}
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
	await page.waitForSelector('.drop-title');

	/* Sample the progress region repeatedly during a real compression. A region
	 * whose text never varies would be read out once, or not at all. */
	await page.setInputFiles('input[type=file]', {
		name: 'photo.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from(photo)
	});
	await page.waitForSelector('button.primary:has-text("Compress PDF")', { timeout: 120_000 });
	await page.waitForSelector('.panel[data-stage="idle"]', { timeout: 120_000 });

	/* The attributes have to be read DURING the busy phase. The markup is
	 * `{#if busy}<div class="progress" role="status" aria-live="polite">`, so
	 * once the run ends the element is gone and querySelector returns null. The
	 * first version read the attributes at the end and reported role=undefined
	 * for all three engines, which reads exactly like a missing live region and
	 * is not one - the same mistake as sampling synchronous code with
	 * setInterval. */
	const seen = new Set();
	let liveAttrs = null;
	const sampling = (async () => {
		for (let i = 0; i < 400; i++) {
			const live = await liveText(page, '.progress').catch(() => null);
			if (live && live.text) {
				seen.add(live.text);
				if (!liveAttrs) liveAttrs = { role: live.role, ariaLive: live.live };
			}
			if (i % 10 === 0) await page.waitForTimeout(10);
		}
	})();

	/* The mode group exists only while the options panel is open, so it is read
	 * here rather than after the result replaces it. */
	const radiogroup = await page.evaluate(() => {
		const g = document.querySelector('[role="radiogroup"]');
		if (!g) return null;
		const radios = [...g.querySelectorAll('input[type=radio]')];
		return {
			label: g.getAttribute('aria-label'),
			radioCount: radios.length,
			checked: radios.filter((r) => r.checked).length,
			allNamed: radios.every((r) => (r.closest('label')?.textContent ?? '').trim().length > 0)
		};
	});

	await page.click('button.primary:has-text("Compress PDF")');
	await page.waitForSelector('.result, .error', { timeout: 180_000 });
	await sampling;

	const signatureNotice = await page.evaluate(() => document.querySelector('.hint')?.textContent?.trim() ?? null);
	const errorRegion = await liveText(page, '.error').catch(() => null);

	/* Now the error path, on a separate page so the result panel is not in play. */
	const page2 = await browser.newPage();
	await page2.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
	await page2.waitForSelector('.drop-title');
	await page2.setInputFiles('input[type=file]', {
		name: 'broken.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from(notAPdf())
	});
	await page2.waitForSelector('.error, .result', { timeout: 120_000 }).catch(() => {});
	const errLive = await liveText(page2, '.error');

	process.stdout.write(`\n  ${name}\n`);
	process.stdout.write(`    progress region : role=${liveAttrs?.role} aria-live=${liveAttrs?.ariaLive}   (read while busy)\n`);
	process.stdout.write(`      distinct texts announced during a run: ${seen.size}\n`);
	for (const t of [...seen].slice(0, 6)) process.stdout.write(`        "${t.slice(0, 62)}"\n`);
	process.stdout.write(`    error region    : role=${errLive?.role} aria-live=${errLive?.live} text="${(errLive?.text ?? '').slice(0, 48)}"\n`);
	process.stdout.write(`    mode group      : ${radiogroup ? `role=radiogroup label="${radiogroup.label}" radios=${radiogroup.radioCount} checked=${radiogroup.checked} allNamed=${radiogroup.allNamed}` : 'ABSENT'}\n`);
	process.stdout.write(`    signature notice: ${signatureNotice ? `"${signatureNotice.slice(0, 58)}"` : 'ABSENT'}\n`);

	await browser.close();
}

server.close();
process.stdout.write('\n');