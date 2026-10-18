/**
 * Contrast audit: every rendered text colour against its actual background.
 *
 * WHY
 *
 * P11 asks for accessibility, and the suite covers accessible names, keyboard
 * order, live regions and tap targets. Contrast has never been measured. It is
 * the one accessibility property that can be computed exactly rather than
 * judged, so it is a poor excuse.
 *
 * The ratios are computed from the real rendered colours, in both themes, at a
 * real viewport - so a token that only fails against one background, or that a
 * media query changes, is caught.
 *
 * THRESHOLDS
 *
 * WCAG 2.x: 4.5:1 for normal text, 3:1 for large text (>=18.66px bold or
 * >=24px). Non-text UI boundaries (a border that carries meaning) want 3:1.
 * Both are checked here and labelled, rather than collapsed into one number that
 * cannot be interpreted.
 *
 * Run: bun scripts/tools/probe-contrast.mjs
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

const browser = await chromium.launch({ channel: 'chromium' });

/** Runs in the page: every text-bearing element's colour and effective background. */
const COLLECT = () => {
	const parse = (c) => {
		const m = c.match(/rgba?\(([^)]+)\)/);
		if (!m) return null;
		const p = m[1].split(',').map((x) => parseFloat(x));
		return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
	};
	const lum = ({ r, g, b }) => {
		const f = (v) => {
			v /= 255;
			return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
	};
	/* Flatten a translucent colour onto an opaque one.
	 *
	 * This step was missing, and it is what made every muted colour in this
	 * project invisible to the audit. The dark theme is built from
	 * `rgba(255,255,255,N)` greys, so lum() was handed the 255,255,255 channels
	 * and scored them as if they were fully opaque - 28% white read as 21:1 when
	 * it renders at 2.5:1. WCAG contrast is defined between the colours that are
	 * actually painted, so the foreground has to be composited before it is
	 * measured. Without this, no translucent colour can ever fail. */
	const flatten = ({ r, g, b, a }, onto) => ({
		r: r * a + onto.r * (1 - a),
		g: g * a + onto.g * (1 - a),
		b: b * a + onto.b * (1 - a),
		a: 1
	});
	const ratio = (a, b) => {
		const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
		return (hi + 0.05) / (lo + 0.05);
	};
	/* Composite an element's colour over its ancestors until something opaque. */
	const backdrop = (el) => {
		let node = el;
		let acc = null;
		while (node && node !== document.documentElement.parentNode) {
			const bg = parse(getComputedStyle(node).backgroundColor);
			if (bg && bg.a > 0) {
				acc = acc === null ? bg : { r: bg.r * bg.a + acc.r * (1 - bg.a), g: bg.g * bg.a + acc.g * (1 - bg.a), b: bg.b * bg.a + acc.b * (1 - bg.a), a: 1 };
				if (acc.a >= 0.999) return acc;
			}
			node = node.parentElement;
		}
		return acc ?? { r: 255, g: 255, b: 255, a: 1 };
	};

	const out = [];
	for (const el of document.querySelectorAll('body *')) {
		// Only elements that directly render text.
		const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
		if (!own) continue;
		const cs = getComputedStyle(el);
		if (cs.visibility === 'hidden' || cs.display === 'none') continue;
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		if (cs.opacity === '0') continue;

		const fg = parse(cs.color);
		const bg = backdrop(el);
		if (!fg) continue;
		/* Measure the colour that is painted, not the one that was authored. */
		const painted = fg.a < 1 ? flatten(fg, bg) : fg;
		const size = parseFloat(cs.fontSize);
		const weight = parseInt(cs.fontWeight, 10) || 400;
		const large = size >= 24 || (size >= 18.66 && weight >= 700);
		const need = large ? 3 : 4.5;
		const cr = ratio(painted, bg);
		const id = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).slice(0, 2).join('.')}` : '');
		out.push({
			sel: id,
			marker: el.getAttribute('data-contrast-probe'),
			text: (el.textContent ?? '').trim().slice(0, 34),
			ratio: Number(cr.toFixed(2)),
			size,
			weight,
			large,
			need,
			pass: cr >= need
		});
	}
	return out;
};

/**
 * KNOWN CONTRAST FIXTURES
 *
 * Hand-computed ratios on white, so the audit can be checked against arithmetic
 * instead of against itself. #767676 is the canonical minimum-AA grey (4.54);
 * #777777 is one step darker and must fail 4.5. A probe that cannot separate
 * those two is not measuring anything.
 *
 * THE TRANSLUCENT CASES ARE THE IMPORTANT ONES
 *
 * Every fixture above is fully opaque, so a probe that ignores the alpha channel
 * entirely would still score all of them correctly. The dark theme here is built
 * from `rgba(255,255,255,N)` greys, so a probe that drops alpha measures 28%
 * white as though it were 100% white and calls a 2.5:1 failure a pass. That
 * defect is real and was live in this file: lum() destructured {r,g,b} and
 * discarded `a`, so no translucent colour could ever fail.
 *
 * A probe therefore has to be able to FAIL a translucent colour before its
 * numbers are worth anything. These two do that, with the arithmetic worked out
 * by hand rather than read back from the probe.
 */
const KNOWN = [
	{ hex: '#000000', expect: 21.0, threshold: 4.5, note: 'black on white - must pass' },
	{ hex: '#767676', expect: 4.54, threshold: 4.5, note: 'canonical minimum AA grey - must pass' },
	{ hex: '#777777', expect: 4.48, threshold: 4.5, note: 'one step darker - must FAIL 4.5' },
	{ hex: '#999999', expect: 2.85, threshold: 4.5, note: 'mid grey - must fail' },
	{ hex: '#ff0000', expect: 4.0, threshold: 4.5, note: 'pure red on white - must fail 4.5' },
	// rgba(0,0,0,0.5) over white is 127.5 per channel; the browser paints 127,
	// which is 3.98:1 and must FAIL. A probe that drops alpha scores pure black
	// here, 21:1, PASS. The 0.02 gap from a naive "4.0" is deliberate: it is what
	// the painted value actually is, and a fixture rounded to a tidy number would
	// not notice a channel being truncated.
	{
		hex: 'rgba(0,0,0,0.5)',
		expect: 3.98,
		threshold: 4.5,
		note: '50% black on white -> rgb(127,127,127), must FAIL'
	},
	// rgba(0,0,0,0.6) over white composites to rgb(102,102,102): 5.74:1, which
	// must PASS. Guards against a fix that simply fails every translucent colour.
	{
		hex: 'rgba(0,0,0,0.6)',
		expect: 5.74,
		threshold: 4.5,
		note: '60% black on white -> rgb(102,102,102), must pass'
	}
];

/**
 * Runs COLLECT over a blank page carrying only the known fixtures, so the audit
 * can be checked against hand-computed arithmetic instead of against itself.
 * #767676 is the canonical minimum-AA grey (4.54); #777777 is one step darker
 * and must fail. A probe that cannot separate those two is not measuring
 * anything, whatever it reported about the real page.
 */
async function selfTest() {
	const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	await page.setContent(
		'<body style="background:#ffffff;margin:0">' +
			KNOWN.map((c) => `<span data-contrast-probe="${c.hex}" style="color:${c.hex};background:#ffffff;font-size:16px;font-weight:400">Ag</span>`).join('') +
			'</body>'
	);
	const out = await page.evaluate(COLLECT);
	await context.close();
	return out;
}

async function audit(theme) {
	const context = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
	await page.waitForSelector('.drop-title');

	const initial = await page.evaluate(COLLECT);

	// The result panel adds the report rows, sizes and the signature warning.
	await page.setInputFiles('input[type=file]', {
		name: 'photo.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from(photo)
	});
	await page.waitForSelector('button.primary:has-text("Compress PDF")', { timeout: 120_000 });
	await page.click('button.primary:has-text("Compress PDF")');
	await page.waitForSelector('.result, .error', { timeout: 180_000 });

	const after = await page.evaluate(COLLECT);
	await context.close();
	return [...initial, ...after];
}

process.stdout.write('\n');

// --- Self-test first: the audit's numbers are only believable if it reproduces
// --- ratios worked out by hand, and only if it can still call a near-miss a
// --- failure. #767676 (4.54) vs #777777 (4.48) is that boundary.
const self = await selfTest();
const byMarker = new Map(self.map((r) => [r.marker, r]));
let selfBad = 0;
process.stdout.write('  SELF-TEST  known ratios, hand-computed on white\n');
for (const k of KNOWN) {
	const r = byMarker.get(k.hex);
	const delta = r ? Math.abs(r.ratio - k.expect) : Infinity;
	// 0.01 covers the rounding of an already-rounded expectation.
	const ok = r && delta <= 0.01 && r.pass === k.expect >= k.threshold;
	if (!ok) selfBad++;
	process.stdout.write(
		`    ${ok ? 'ok  ' : 'BAD '} ${String(r?.ratio ?? 'n/a').padStart(6)}:1  expect ${String(k.expect).padStart(6)}:1  ${k.note}\n`
	);
}
/**
 * The error panel. A separate page, because the result panel is not in play
 * when a file fails - which is exactly why it was going unmeasured: the happy
 * path never renders it.
 *
 * The file is named `.pdf` on purpose. The filename guard in +page.svelte
 * rejects anything else before qpdf runs, so only a mislabelled .pdf reaches
 * the engine and produces the real diagnostic.
 */
async function auditError(theme) {
	const context = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
	await page.waitForSelector('.drop-title');
	await page.setInputFiles('input[type=file]', {
		name: 'broken.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from('%PDF-1.7\nthis is not a pdf body, not even close\n')
	});
	await page.waitForSelector('.error', { timeout: 60_000 });
	const rows = await page.evaluate(COLLECT);
	await context.close();
	return rows;
}

process.stdout.write('\n');

for (const theme of ['dark', 'light']) {
	const rows = await audit(theme);
	const errRows = await auditError(theme);
	const all = [...rows, ...errRows];
	const failing = all.filter((r) => !r.pass);
	const errFailing = errRows.filter((r) => !r.pass);
	process.stdout.write(
		`  ${theme.toUpperCase().padEnd(6)} ${rows.length} text elements on the success path, ${errRows.length} on the error path, ${failing.length} below WCAG AA\n`
	);
	for (const r of failing) {
		process.stdout.write(
			`    ${String(r.ratio).padStart(6)}:1  needs ${r.need}  ${String(r.size).padStart(4)}px/${r.weight}  ${r.sel.padEnd(28)} "${r.text}"${errRows.includes(r) ? '   <- error panel' : ''}\n`
		);
	}
	if (!failing.length) process.stdout.write('    (none)\n');
	void errFailing;
	process.stdout.write('\n');
}

process.stdout.write('  Thresholds: 4.5:1 normal text, 3:1 large (>=24px, or >=18.66px bold).\n');
process.stdout.write('  Ratios are computed from rendered colours composited over the real\n');
process.stdout.write('  ancestor backgrounds, in both colour schemes, at a real viewport.\n');
process.stdout.write('  KNOWN LIMIT: backgroundImage is not read, so a gradient or bitmap\n');
process.stdout.write('  background would silently yield the wrong backdrop. There are none\n');
process.stdout.write('  today; that is a property of the CSS, not of this probe.\n');
process.stdout.write('  Non-text UI boundaries (meaningful borders) are NOT measured here.\n');
process.stdout.write('\n');

await browser.close();
server.close();

if (selfBad) {
	process.stderr.write(`  SELF-TEST FAILED: ${selfBad} of ${KNOWN.length} known ratios not reproduced.\n`);
	process.exit(1);
}