/**
 * Image fidelity: what actually happens to pixels.
 *
 * `qpdf --check` cannot see whether a re-encoded image still looks right, and
 * neither can the structure reader. This measures it directly: decode the
 * image as it was in the input, decode it again as it is in the output, and
 * compare the raster.
 *
 * Three metrics, all cheap and all interpretable:
 *
 *   MAE    mean absolute error per channel, 0-255. A coarse overall drift.
 *   MAX    largest single-channel difference anywhere. Catches a blown-out
 *          region that an average would hide.
 *   OVER%  share of pixels differing by more than a fixed threshold. Catches
 *          structural damage - wrong colours, muddied fine detail - that a
 *          mean over a mostly-flat image would also hide.
 *
 * These are REGRESSION thresholds, not a perceptual-quality score. A number
 * here does not mean "looks good to a human"; it means "did not get worse than
 * last time, in a way this metric can see". Lossy compression is lossy.
 *
 * Usage: bun scripts/test/test-fidelity.mjs [--measure]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { optimize } from '../../src/lib/qpdf/pipeline.ts';
import { findJpegImages } from '../../src/lib/qpdf/images.ts';
import { bytesEqual } from '../../src/lib/qpdf/bytes.ts';
import { makeRunner, makeCodec, makeZip } from '../lib/engine.mjs';
import { FIXTURES } from '../lib/fixture-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

const MEASURE_ONLY = process.argv.includes('--measure');

const runner = makeRunner();
const codec = await makeCodec();
const zip = makeZip();

const load = (n) => readFile(path.join(here, '..', 'fixtures', n)).then((b) => new Uint8Array(b));

/* ── metrics ──────────────────────────────────────────────────────────────── */

/**
 * Compare two decoded rasters.
 *
 * Grayscale is expanded to RGB by the decoder, so both sides are RGB and the
 * channels are directly comparable.
 */
function compareRasters(a, b) {
	if (a.width !== b.width || a.height !== b.height) {
		return { sizeMismatch: true, mae: Infinity, max: Infinity, over: 100, note: `${a.width}x${a.height} vs ${b.width}x${b.height}` };
	}
	const n = a.width * a.height * 4;
	let sum = 0;
	let max = 0;
	let over = 0;

	for (let i = 0; i < n; i += 4) {
		for (let c = 0; c < 3; c++) {
			const d = Math.abs(a.data[i + c] - b.data[i + c]);
			sum += d;
			if (d > max) max = d;
			if (d > 32) over++;
		}
	}

	const pixels = a.width * a.height;
	return {
		sizeMismatch: false,
		mae: sum / (pixels * 3),
		max,
		// Percentage of channels, not pixels, so it is comparable to `mae`.
		over: (over / (pixels * 3)) * 100,
		identical: sum === 0
	};
}

/** Every DCTDecode image, flattened so the payload is reachable. */
async function imagesOf(bytes) {
	const flat = await runner(bytes, ['--object-streams=disable', '--stream-data=preserve']);
	if (!flat.out) return null;
	return findJpegImages(Buffer.from(flat.out).toString('latin1'));
}

/* ── thresholds ───────────────────────────────────────────────────────────── */

/**
 * Regression limits, set by measuring first and then rounding outward.
 *
 * Measured on this corpus (MAE / MAX / OVER%):
 *   Lossless     every fixture                      0 / 0 / 0    - exactly identical
 *   Balanced     photographs, gradients, flats      0.0-1.0 / 4-9 / 0
 *   Balanced     noise, 1px checkerboard            25-57 / 109-171 / 30-97
 *   Maximum      photographs, gradients, flats      0.0-1.0 / 4-5 / 0
 *   Maximum      noise, 1px checkerboard            32-57 / 188 / 41-97
 *
 * Two groups, because JPEG itself has two very different failure modes:
 *
 *   normal   content with real spatial correlation - a photograph, a gradient.
 *            Re-encoding these changes almost nothing, and a regression here
 *            means something is genuinely wrong.
 *
 *   hostile  incompressible noise and a 1px checkerboard. No JPEG encoder can
 *            preserve either; a checkerboard simply *is* high-frequency
 *            detail. The bounds here only catch a regression that is worse
 *            than re-encoding the source, such as a colour swap or a
 *            mis-decoded channel.
 *
 * These are regression thresholds, NOT a perceptual-quality score. A number
 * below does not mean "looks acceptable to a human", and lossy compression is
 * by definition lossy.
 */
const LIMITS = {
	lossless: { mae: 0, max: 0, over: 0 },
	balanced: {
		normal: { mae: 4, max: 64, over: 6 },
		hostile: { mae: 70, max: 220, over: 100 }
	},
	maximum: {
		normal: { mae: 4, max: 64, over: 6 },
		hostile: { mae: 70, max: 255, over: 100 }
	}
};

let passed = 0;
let failed = 0;
const failures = [];
const rows = [];

async function test(name, fn) {
	try {
		await fn();
		passed++;
	} catch (err) {
		failed++;
		failures.push(`${name}: ${err.message}`);
		report(`  FAIL  ${name}`);
		report(`        ${err.message}`);
	}
}

function assert(cond, what) {
	if (!cond) throw new Error(what);
}

/* ── the suite ────────────────────────────────────────────────────────────── */

report('');
report('Image fidelity');

/* Lossless: decoded pixels must be IDENTICAL, not merely close. */
for (const [name, spec] of Object.entries(FIXTURES)) {
	if (!spec.jpeg) continue;
	if (spec.valid === false) continue;
	const bytes = await load(name);
	const before = await imagesOf(bytes);
	if (!before?.length) continue;

	await test(`lossless: ${name} decodes to identical pixels`, async () => {
		const res = await optimize({ bytes, mode: 'lossless' }, runner, codec);
		const after = await imagesOf(res.bytes);
		if (!after?.length) return; // dedupe removed every copy; nothing to compare

		for (const img of after) {
			const original = before.find((b) => bytesEqual(b.data, img.data));
			assert(original, 'output image payload is not byte-identical to any input image');
			const unwrap = async (im) => (im.encoding === 'flate-jpeg' ? await zip.inflate(im.data) : im.data);
			const a = await codec.decode(await unwrap(original));
			const b = await codec.decode(await unwrap(img));
			const r = compareRasters(a, b);
			assert(!r.sizeMismatch, `size changed: ${r.note}`);
			assert(r.identical, `pixels changed: MAE ${r.mae}, MAX ${r.max}, OVER ${r.over.toFixed(2)}%`);
			rows.push({ fixture: name, mode: 'lossless', ...r });
		}
	});
}

/* Lossy: measured error must stay within the documented regression limits. */
for (const mode of ['balanced', 'maximum']) {
	for (const [name, spec] of Object.entries(FIXTURES)) {
		if (!spec.jpeg || !spec.reencodable) continue;
		if (spec.valid === false) continue;
		const bytes = await load(name);
		const before = await imagesOf(bytes);
		if (!before?.length) continue;

		await test(`${mode}: ${name} stays within fidelity limits`, async () => {
			const res = await optimize({ bytes, mode, zip }, runner, codec);
			const after = await imagesOf(res.bytes);
			if (!after?.length) return;

			const hostile = !!spec.hostile;
			const limit = LIMITS[mode][hostile ? 'hostile' : 'normal'];

			for (const img of after) {
				const original = before.find((b) => b.width === img.width && b.height === img.height);
				if (!original) continue;

			const unwrap = async (im) => (im.encoding === 'flate-jpeg' ? await zip.inflate(im.data) : im.data);
			const a = await codec.decode(await unwrap(original));
			const b = await codec.decode(await unwrap(img));
				const r = compareRasters(a, b);
				assert(!r.sizeMismatch, `size changed unexpectedly: ${r.note}`);
				rows.push({ fixture: name, mode, ...r });

				if (MEASURE_ONLY) continue;

				// A perfectly re-encoded image is the strongest possible
				// evidence and must never be rejected for being identical.
				if (r.identical) continue;

				assert(
					r.mae <= limit.mae,
					`MAE ${r.mae.toFixed(2)} exceeds ${limit.mae} (limit${hostile ? ', hostile fixture' : ''})`
				);
				assert(r.max <= limit.max, `MAX ${r.max} exceeds ${limit.max}`);
				assert(r.over <= limit.over, `OVER ${r.over.toFixed(2)}% exceeds ${limit.over}%`);
			}
		});
	}
}

/* Dimension handling: downscaling must keep the aspect ratio sane. */
await test('downscaling preserves aspect ratio and never produces a zero dimension', async () => {
	const bytes = await load('oversized-600dpi.pdf');
	const res = await optimize({ bytes, mode: 'maximum' }, runner, codec);
	const after = await imagesOf(res.bytes);
	for (const img of after) {
		assert(img.width > 0 && img.height > 0, `zero dimension: ${img.width}x${img.height}`);
		const ratio = img.width / img.height;
		assert(ratio > 0.6 && ratio < 0.8, `aspect ratio drifted to ${ratio.toFixed(3)} (source 2480x3508)`);
	}
});

/* ── report ───────────────────────────────────────────────────────────────── */

report('');
report('  measured (MAE = mean absolute error per channel 0-255, OVER = % channels differing by >32)');
report(`  ${'fixture'.padEnd(28)} ${'mode'.padEnd(10)} ${'MAE'.padStart(7)} ${'MAX'.padStart(6)} ${'OVER%'.padStart(7)}`);
report('  ' + '-'.repeat(62));
for (const r of rows) {
	if (MEASURE_ONLY || r.mae === 0) {
		report(
			`  ${r.fixture.padEnd(28)} ${r.mode.padEnd(10)} ${r.mae.toFixed(2).padStart(7)} ` +
				`${String(r.max).padStart(6)} ${r.over.toFixed(2).padStart(7)}`
		);
	}
}
report('');
report(`${passed} passed, ${failed} failed, ${rows.length} raster comparisons`);
if (failures.length) {
	report('\nFailures:');
	for (const f of failures) report(`  - ${f}`);
}
report('');
process.exit(failed ? 1 : 0);
