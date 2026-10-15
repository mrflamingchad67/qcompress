/**
 * P2 follow-up - resize kernel benchmark on rendered pages.
 *
 * Triangle is 2.9x faster than the library's inherited default, but bilinear
 * downsampling softens thin strokes, which is exactly where text and line art
 * suffer. So the kernel choice cannot be settled on speed or on MAE measured
 * between intermediate buffers; it has to be settled on RENDERED PAGES, against
 * the original document, using the same comparator the visual suite gates on.
 *
 * No production code is modified. `optimize` takes the codec as a parameter, so
 * each variant is injected as a wrapper around the real one. That is the point:
 * the alternatives are measured through the real pipeline, not a simulation.
 *
 * Usage: bun scripts/tools/kernel-bench.mjs [--scale <n>]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');

const { optimize } = await import(`${REPO}/src/lib/qpdf/pipeline.ts`);
const { makeRunner, makeCodec, makeZip } = await import(`${REPO}/scripts/lib/engine.mjs`);
const { startRenderer } = await import(`${REPO}/scripts/lib/render.mjs`);
const { FIXTURES } = await import(`${REPO}/scripts/lib/fixture-manifest.mjs`);
const resizeRaw = (await import(`${REPO}/node_modules/@jsquash/resize/index.js`)).default;

const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const argv = process.argv.slice(2);
const scaleIdx = argv.indexOf('--scale');
const SCALE = scaleIdx !== -1 ? Number(argv[scaleIdx + 1]) : 1.5;

/* Grouped by what each is a worst case FOR, because a kernel can be fine on
 * photographs and poor on text and the average of the two hides both. */
const CASES = [
	{ category: 'photograph', fixtures: ['photo-q90.pdf', 'oversized-600dpi.pdf'] },
	{ category: 'text scan', fixtures: ['scan-300dpi-q80.pdf'] },
	{ category: 'diagram', fixtures: ['graphic-q75.pdf'] }
];

/* The last entry is what the code did before this change: jSquash's inherited
 * defaults, spelled out so the comparison includes the real baseline. */
const VARIANTS = [
	{ label: 'triangle  linRGB off', opts: { method: 'triangle', premultiply: false, linearRGB: false }, current: true },
	{ label: 'triangle  linRGB on', opts: { method: 'triangle', premultiply: false, linearRGB: true } },
	{ label: 'catrom    linRGB off', opts: { method: 'catrom', premultiply: false, linearRGB: false } },
	{ label: 'mitchell  linRGB off', opts: { method: 'mitchell', premultiply: false, linearRGB: false } },
	{ label: 'lanczos3  linRGB off', opts: { method: 'lanczos3', premultiply: false, linearRGB: false } },
	{ label: 'lanczos3  linRGB on (was: defaults)', opts: { method: 'lanczos3', premultiply: true, linearRGB: true } }
];

const runner = makeRunner();
const baseCodec = await makeCodec();
const zip = makeZip();

/** The real codec with only the resize options swapped. */
const withResize = (opts) => ({
	...baseCodec,
	resize: (image, w, h) => resizeRaw(image, { ...opts, width: w, height: h })
});

const renderer = await startRenderer({ scale: SCALE });
log('');
log(`resize kernel benchmark - rendered pages, scale ${SCALE}, mode maximum`);
log(`maxLongEdge for maximum is 1700, so only images above that are resized`);
log('');

const summary = [];

try {
	for (const { category, fixtures } of CASES) {
		log(`── ${category} ${'─'.repeat(Math.max(0, 58 - category.length))}`);

		for (const name of fixtures) {
			const spec = FIXTURES[name];
			if (!spec) {
				log(`  ${name}: not in the manifest, skipping`);
				continue;
			}
			if (spec.valid === false) {
				log(`  ${name}: deliberately broken fixture, skipping`);
				continue;
			}

			const bytes = new Uint8Array(await readFile(path.join(REPO, 'scripts', 'fixtures', name)));
			const rows = [];
			const outputs = new Map();

			for (const v of VARIANTS) {
				const t0 = Date.now();
				let out;
				try {
					out = await optimize({ bytes, mode: 'maximum', zip }, runner, withResize(v.opts));
				} catch (err) {
					log(`  ${name} ${v.label}: compression failed: ${err.message}`);
					continue;
				}
				const ms = Date.now() - t0;
				outputs.set(v.label, out.bytes);

				let pageErr = null;
				let result = null;
				try {
					result = await renderer.comparePair(bytes, out.bytes, 'maximum', !!spec.hostile, (spec.reencodable ?? 0) > 0);
				} catch (err) {
					pageErr = String(err.message).split('\n')[0];
				}

				if (pageErr || !result || result.errors?.length) {
					log(`  ${name} ${v.label}: renderer problem - ${pageErr ?? result?.errors?.[0]}`);
					continue;
				}

				const pages = result.pages;
				if (!pages.length) {
					log(`  ${name} ${v.label}: rendered 0 pages`);
					continue;
				}
				// Metrics live under `p.metrics`, not on the page itself.
				const mean = (k) => pages.reduce((a, p) => a + (p.metrics?.[k] ?? 0), 0) / pages.length;
				rows.push({
					label: v.label,
					current: !!v.current,
					ms,
					bytes: out.bytes.length,
					mae: mean('mae'),
					hard: Math.max(...pages.map((p) => p.metrics?.hardPct ?? 0)),
					changed: mean('changedPct')
				});
			}

			/* If every variant produced identical bytes, no image was resized and
			 * the kernel comparison is meaningless for this fixture. Say so
			 * rather than printing a table of identical numbers. */
			const distinct = new Set([...outputs.values()].map((b) => b.length)).size;
			const noResize = distinct === 1;
			log('');
			log(`  ${name}  (${bytes.length} B, ${spec.reencodable ?? 0} reencodable)`);
			if (noResize) {
				log(`    all ${outputs.size} variants produced the same size - no image exceeded 1700px,`);
				log(`    so nothing was resized and this fixture cannot distinguish the kernels`);
				continue;
			}

			log(
				`    ${'variant'.padEnd(36)} ${'ms'.padStart(6)} ${'bytes'.padStart(9)} ${'mae'.padStart(7)} ` +
					`${'hard%'.padStart(7)} ${'chg%'.padStart(7)}`
			);
			for (const r of rows) {
				log(
					`    ${(r.current ? '* ' : '') + r.label.padEnd(34)} ${String(r.ms).padStart(6)} ` +
						`${String(r.bytes).padStart(9)} ${r.mae.toFixed(3).padStart(7)} ` +
						`${r.hard.toFixed(3).padStart(7)} ${r.changed.toFixed(2).padStart(7)}`
				);
			}
			summary.push({ category, name, rows });
			log('');
		}
	}
} finally {
	await renderer.release();
}

log('* = currently configured in RESIZE_OPTIONS');
log('');
log('mae  = mean absolute pixel error vs the ORIGINAL rendered page (lower is better)');
log('hard%= worst page, pixels differing by >= 96 levels - visible damage');
log('chg% = mean share of pixels differing at all; high values with low mae are re-encoding');
log('');
log('These are measurements, not assertions. Nothing here gates.');
log('');

/* The renderer holds a Chromium instance and an HTTP server open, so the event
 * loop never drains on its own. Without this the benchmark finishes all of its
 * work, prints its results, and then sits there looking hung. */
process.exit(0);