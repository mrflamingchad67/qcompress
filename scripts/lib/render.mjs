/**
 * Rendering harness: runs PDF.js inside Chromium and compares rendered pages.
 *
 * WHY THE BROWSER, NOT NODE
 *
 * PDF.js draws to a canvas. In Node that means a native canvas binding
 * (`canvas` or `@napi-rs/canvas`) - a compiled, platform-specific dependency,
 * with different behaviour on a Windows dev box and a Linux CI runner. Chromium
 * is already a dependency here (Playwright, for test:browser) and already
 * provides a canvas, so rendering there costs no extra native dependency and
 * behaves identically in both environments.
 *
 * The trade-off is honest: this suite needs a browser. Where Chromium is not
 * installed it cannot run, and that is reported rather than skipped silently.
 *
 * WHAT IS SERVED
 *
 *   /visual.html            a blank page; the app build is not involved
 *   /pdfjs/*                pdfjs-dist build/, standard_fonts/, cmaps/
 *   /testlib/*              scripts/lib/ - the comparator under test
 *
 * Nothing here is bundled, served to production, or reachable from the
 * deployed site. It exists only for the lifetime of the test process.
 *
 * WHAT COMES BACK
 *
 * Metrics, not pixels. A 1.5x letter page is ~4 MB of RGBA; comparing in the
 * page and returning a few hundred bytes per page is the difference between a
 * suite that runs in a minute and one that runs in ten.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const pdfjsRoot = path.join(root, 'node_modules', 'pdfjs-dist');

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.map': 'application/json',
	'.json': 'application/json',
	'.bcmap': 'application/octet-stream',
	'.pfb': 'application/octet-stream',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf'
};

/**
 * @returns {Promise<{server: import('node:http').Server, port: number}>}
 */
function serve() {
	// A 404 here means the harness is mis-wired (wrong pdfjs path, a missing
	// font resource). Recording the URL turns a bare "renderer did not
	// become ready" into an actionable message.
	const missing = [];
	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://localhost');
		const route = decodeURIComponent(url.pathname);

		try {
			let file;
			if (route === '/visual.html') {
				// Intentionally minimal. No app code, no network, no styles:
				// the only thing this page does is host the renderer.
				res.writeHead(200, { 'content-type': MIME['.html'] });
				res.end(
					'<!doctype html><meta charset="utf-8"><title>visual</title>' +
						// Empty data URI: suppresses the browser's automatic
						// /favicon.ico request, which would otherwise surface as
						// a 404 and a console error on every page.
						'<link rel="icon" href="data:,">' +
						'<body><script type="module" src="/testlib/visual-page.mjs"></script>'
				);
				return;
			} else if (route.startsWith('/pdfjs/')) {
				const rest = route.slice('/pdfjs/'.length);
				// build/ holds the modules; standard_fonts/ and cmaps/ sit at
				// the package root. Map both under one prefix.
				if (rest.startsWith('standard_fonts/')) {
					file = path.join(pdfjsRoot, 'standard_fonts', rest.slice('standard_fonts/'.length));
				} else if (rest.startsWith('cmaps/')) {
					file = path.join(pdfjsRoot, 'cmaps', rest.slice('cmaps/'.length));
				} else {
					file = path.join(pdfjsRoot, 'build', rest);
				}
			} else if (route.startsWith('/testlib/')) {
				file = path.join(here, route.slice('/testlib/'.length));
			} else {
				missing.push(route);
				res.writeHead(404).end('not found');
				return;
			}

			const body = await readFile(file);
			res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
			res.end(body);
		} catch {
			missing.push(route);
			res.writeHead(404).end('not found');
		}
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, missing }));
	});
}

/**
 * Default render scale.
 *
 * 1.5 puts a 612x792pt page at 918x1188px - roughly screen-reading size.
 * That is enough for 9-10pt body text to be several pixels tall, so a missing
 * glyph is unmistakable, while keeping a 40-fixture x 3-mode run to a few
 * minutes. Going much above this buys resolution the fixtures do not need and
 * costs proportionally in render time and memory.
 */
export const DEFAULT_SCALE = 1.5;

/**
 * Start a browser session with the renderer loaded.
 *
 * @param {{scale?:number, diagnose?:boolean, diagnosticsDir?:string}} opts
 */
export async function startRenderer(opts = {}) {
	const scale = opts.scale ?? DEFAULT_SCALE;
	const { server, port, missing } = await serve();
	const browser = await chromium.launch({ channel: 'chromium' });
	const base = `http://127.0.0.1:${port}`;

	let context;
	let page;

	async function boot() {
		if (context) await context.close().catch(() => {});
		context = await browser.newContext();
		page = await context.newPage();

		// A renderer failure must be a test failure, not a silent blank page.
		const errors = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push(m.text());
		});

		await page.goto(`${base}/visual.html`, { waitUntil: 'load' });
		try {
			await page.waitForFunction(() => !!window.VISUAL, null, { timeout: 60_000 });
		} catch (err) {
			// A module that failed to load, or a worker that refused to start,
			// shows up as a page error. Reporting the timeout alone would hide
			// the actual cause.
			throw new Error(
				`renderer did not become ready: ${err.message}` +
					(errors.length ? `\n  page errors:\n    ${errors.join('\n    ')}` : '\n  (no page errors captured)') +
					(missing.length ? `\n  404s:\n    ${[...new Set(missing)].join('\n    ')}` : '')
			);
		}
		return errors;
	}

	let errors = await boot();

	/** Re-open the page after a renderer crash, so one bad fixture is not fatal. */
	async function reboot() {
		errors = await boot();
	}

	/**
	 * Render both documents and compare them page by page.
	 *
	 * @param {Uint8Array} originalBytes
	 * @param {Uint8Array} candidateBytes
	 * @param {'lossless'|'balanced'|'maximum'} mode
	 * @param {boolean} hostile fixture is declared hostile in the manifest
	 * @param {boolean} mayReencode fixture has at least one eligible image; false
	 *   means no mode may change a pixel (see policyFor)
	 * @returns {Promise<object>} page/aggregate metrics plus any renderer errors
	 */
	async function comparePair(originalBytes, candidateBytes, mode, hostile, mayReencode = true) {
		const b64A = Buffer.from(originalBytes).toString('base64');
		const b64B = Buffer.from(candidateBytes).toString('base64');

		// One round trip. Both documents are loaded, rendered and compared in
		// the page, where the rasters already live; only metrics come back.
		const result = await page.evaluate(
			async ([b64A, b64B, mode, hostile, mayReencode, scale]) => {
				const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

				const nA = await window.VISUAL.load('original', b64A);
				const nB = await window.VISUAL.load('candidate', b64B);

				// Both documents are rendered even when their page counts
				// differ, so the comparator can report a page-count failure
				// from real geometry rather than refusing to pair them.
				await Promise.all([
					window.VISUAL.render('original', scale, range(nA)),
					window.VISUAL.render('candidate', scale, range(nB))
				]);

				return window.VISUAL.compare('original', 'candidate', mode, hostile, mayReencode);
			},
			[b64A, b64B, mode, hostile, mayReencode, scale]
		);

		return {
			...result,
			pageCount: result.pageCounts,
			errors: [...errors, ...[...new Set(missing)].map((m) => `404 ${m}`)]
		};
	}

	/** PNG data URL for one page: original | candidate | difference. */
	async function diagnose(pageNumber, maxWidth = 900) {
		return page.evaluate(
			([n, w]) => window.VISUAL.diffPng('original', 'candidate', n, w),
			[pageNumber, maxWidth]
		);
	}

	/** Release both documents. Called between fixtures to bound memory. */
	async function release() {
		await page
			.evaluate(() =>
				Promise.all([window.VISUAL.dispose('original'), window.VISUAL.dispose('candidate')])
			)
			.catch(async () => {
				await reboot();
			});
	}

	async function close() {
		await context?.close().catch(() => {});
		await browser.close().catch(() => {});
		server.close();
	}

	return {
		comparePair,
		diagnose,
		release,
		reboot,
		close,
		get page() {
			return page;
		},
		get errors() {
			return errors;
		}
	};
}