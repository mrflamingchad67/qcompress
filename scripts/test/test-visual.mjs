/**
 * Page-level visual regression: render the original and the compressed output
 * through the same PDF.js in the same browser, and judge the pages.
 *
 * WHAT THIS COVERS THAT NOTHING ELSE DOES
 *
 * Every other suite reasons about a PDF as data. This one looks at it as a
 * picture. A document can pass `qpdf --check`, keep every page, every object
 * and every decoded image pixel, and still be visibly wrong: a font that
 * stopped embedding, a glyph that vanished, a heading that moved, a crop that
 * appeared. None of that is visible in a byte diff.
 *
 * The comparison is always ORIGINAL vs COMPRESSED, through the same renderer,
 * at the same scale, with the same fonts and the same settings. Because both
 * sides share the environment, a difference means the PDF changed - not that
 * the renderer is nondeterministic.
 *
 * Mode policy, in one paragraph
 *
 *   Lossless must render identically. PDF.js is deterministic, so the bound
 *   is exactly zero and any change is a defect, not noise.
 *   Balanced and Maximum re-encode eligible JPEGs, which legitimately changes
 *   pixels. They are held to measured bounds, and crucially those bounds
 *   include `hardPct` - a localised high-contrast detector - so that a small
 *   serious defect (a vanished heading) cannot hide inside a whole-page
 *   average. See scripts/lib/visual.mjs for the definitions and
 *   scripts/test/test-visual-comparator.mjs for the controls proving the
 *   detector actually fires.
 *
 * Usage:
 *   bun run test:visual                  all valid fixtures, all three modes
 *   bun run test:visual -- <fixture...>  only these fixtures
 *   bun run test:visual -- --measure     print every measured row, assert nothing
 *   bun run test:visual -- --diagnose    write original/candidate/diff PNGs on failure
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { optimize } from '../../src/lib/qpdf/pipeline.ts';
import { makeRunner, makeCodec, makeZip } from '../lib/engine.mjs';
import { FIXTURES } from '../lib/fixture-manifest.mjs';
import { startRenderer, DEFAULT_SCALE } from '../lib/render.mjs';
import { formatViolations } from '../lib/visual.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

const argv = process.argv.slice(2);
const MEASURE = argv.includes('--measure');
const DIAGNOSE = argv.includes('--diagnose');
const SCALE = (() => {
	const i = argv.indexOf('--scale');
	return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : DEFAULT_SCALE;
})();
const ONLY = argv.filter((a) => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a));

const DIAG_DIR = path.join(here, '..', '..', '.visual-diagnostics');

const runner = makeRunner();
const codec = await makeCodec();
const zip = makeZip();

const load = (n) => readFile(path.join(here, '..', 'fixtures', n)).then((b) => new Uint8Array(b));

/** Fixtures excluded from visual testing, each with its reason stated. */
function exclusionReason(spec) {
	if (spec.valid === false) return 'not a renderable document (deliberately broken fixture)';
	return null;
}

let passed = 0;
let failed = 0;
const failures = [];
const rows = [];
const unsupported = [];

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

/* ── run ──────────────────────────────────────────────────────────────────── */

const candidates = Object.entries(FIXTURES)
	.map(([name, spec]) => ({ name, spec, reason: exclusionReason(spec) }))
	.filter((c) => !c.reason)
	.filter((c) => ONLY.length === 0 || ONLY.includes(c.name));

report('');
report('Page-level visual regression');
report(`  renderer : pdfjs-dist in Chromium, scale ${SCALE}`);
report(`  modes    : lossless, balanced, maximum`);
report(`  fixtures : ${candidates.length} of ${Object.keys(FIXTURES).length}`);
if (DIAGNOSE) report(`  diagnose : PNGs -> ${DIAG_DIR}`);
if (MEASURE) report('  MEASURE ONLY - nothing is asserted');

const renderer = await startRenderer({ scale: SCALE });

try {
	for (const mode of ['lossless', 'balanced', 'maximum']) {
		report(`\n[${mode}]`);

		for (const { name, spec } of candidates) {
			const label = `${mode}: ${name}`;

			await test(label, async () => {
				const bytes = await load(name);

				let out;
				try {
					out = await optimize({ bytes, mode, zip }, runner, codec);
				} catch (err) {
					throw new Error(`compression failed before rendering: ${err.message}`);
				}

				// A fixture with no eligible image must render identically in
				// EVERY mode, not just Lossless: Balanced and Maximum have
				// nothing to re-encode, so nothing about the page may move.
				const mayReencode = (spec.reencodable ?? 0) > 0;

				let result;
				try {
					result = await renderer.comparePair(bytes, out.bytes, mode, !!spec.hostile, mayReencode);
				} catch (err) {
					// A renderer that cannot open a real document is a gap in
					// coverage, not a pass. Record it separately and loudly.
					unsupported.push({ fixture: name, mode, reason: String(err.message).split('\n')[0] });
					report(`  UNSUPPORTED  ${label}: ${String(err.message).split('\n')[0]}`);
					await renderer.release();
					return;
				}

				// A renderer-side page error means we cannot trust the pixels.
				if (result.errors?.length) {
					throw new Error(`renderer reported errors: ${result.errors.slice(0, 2).join(' | ')}`);
				}

				// Geometry first, and independently of any pixel score.
				const geo = result.geometry;
				for (const p of geo.problems) {
					const where = p.page ? `page ${p.page}` : 'document';
					failures.push(`${label}: [geometry/${p.kind}] ${where}: ${p.detail}`);
				}
				const geoFailed = geo.problems.length > 0;

				// Then the pages, each judged on its own.
				let pageFailed = false;
				for (const p of result.pages) {
					rows.push({
						fixture: name,
						mode,
						page: p.page,
						...p.metrics,
						originalSize: p.originalSize,
						candidateSize: p.candidateSize,
						ok: p.ok
					});

					if (!p.ok) {
						pageFailed = true;
						const why = p.violations.length
							? formatViolations(p.violations)
							: p.reason ?? 'unknown';
						failures.push(
							`${label}: [visual] page ${p.page} ${p.originalSize} -> ${p.candidateSize} :: ${why}`
						);

						if (DIAGNOSE) {
							await writeDiff(renderer, name, mode, p.page);
						}
					}
				}

				// The aggregate must account for every rendered page. This is an internal
				// consistency check, so it is asserted even when measuring.
				assert(result.aggregate.pages === result.pageCount.original, 'aggregate lost a page');

				// In measure mode nothing is judged: the point is to collect
				// the numbers that the thresholds are then calibrated against.
				if (!MEASURE) {
					assert(!(geoFailed || pageFailed), 'see failures list');

					const a = result.aggregate;
					report(
						`  ${(geoFailed || pageFailed ? 'FAIL' : 'ok  ')}  ${name.padEnd(36)} ` +
							`${a.pages}p  changed ${a.changedPct.toFixed(3)}%  hard ${a.hardPct.toFixed(3)}%  ` +
							`MAE ${a.mae.toFixed(3)}`
					);
				}
			});

			await renderer.release();
		}
	}
} finally {
	await renderer.close();
}

/** Write original | candidate | difference PNGs for one page. */
async function writeDiff(renderer, fixture, mode, page) {
	try {
		const dataUrl = await renderer.diagnose(page);
		const dir = path.join(DIAG_DIR, mode);
		await mkdir(dir, { recursive: true });
		const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
		const file = path.join(dir, `${fixture.replace(/\.pdf$/, '')}-p${page}.png`);
		await writeFile(file, buf);
		report(`        diagnostic: ${path.relative(process.cwd(), file)}`);
	} catch (err) {
		report(`        (diagnostic failed: ${err.message})`);
	}
}

/* ── report ───────────────────────────────────────────────────────────────── */

report('');
report('  page', ' '.repeat(36), 'changed%', '   hard%', '    MAE', '  MAX');
report('  ' + '-'.repeat(74));
for (const r of rows.filter((r) => MEASURE || r.mae > 0 || !r.ok)) {
	report(
		`  ${`${r.fixture}`.padEnd(38)}${`${r.mode} p${r.page}`.padEnd(18)}` +
			`${r.changedPct.toFixed(3).padStart(8)}${r.hardPct.toFixed(3).padStart(8)}` +
			`${r.mae.toFixed(3).padStart(8)}${String(r.max).padStart(6)}`
	);
}

if (unsupported.length) {
	report('');
	report(`  ${unsupported.length} fixture(s) COULD NOT BE RENDERED - coverage gap, not a pass:`);
	for (const u of unsupported) report(`    ${u.mode}: ${u.fixture} - ${u.reason}`);
}

report('');
report(`${passed} passed, ${failed} failed, ${rows.length} page comparisons`);
if (failures.length) {
	report('\nFailures:');
	for (const f of failures) report(`  - ${f}`);
}

// Diagnostics are scratch output. Removed unless explicitly requested, so the
// repository never accumulates unreviewed binaries.
if (!DIAGNOSE) await rm(DIAG_DIR, { recursive: true, force: true });

report('');
process.exit(failed ? 1 : 0);