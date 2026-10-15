/**
 * Comparator unit tests and negative controls.
 *
 * This suite does not render a PDF and does not start a browser. It proves
 * that the comparison and policy logic responds correctly at known boundaries
 * - including at boundaries that MUST fail.
 *
 * Why negative controls are not optional
 *
 * A visual suite that only reports passes is worthless: a comparator that
 * returned zero for everything would look identical to a correct one. Every
 * important rule below is therefore exercised with a deliberately broken input
 * that is required to be detected. If someone weakens `hardPct` to make a real
 * fixture pass, the corresponding control fails and says so.
 *
 * The headline case is [3]: a small, severe change that a whole-page mean
 * cannot see. It is the reason `hardPct` exists.
 *
 * Usage: bun run test:visual-comparator
 */
import {
	compareRasters,
	solidRaster,
	checkGeometry,
	evaluate,
	policyFor,
	aggregate,
	formatViolations,
	GEOMETRY_TOLERANCE,
	EPSILON,
	HARD_DELTA
} from '../lib/visual.mjs';

let passed = 0;
let failed = 0;
const failures = [];
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

function test(name, fn) {
	try {
		fn();
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

/** Paint a filled rectangle into a raster, in place. */
function paintRect(raster, x, y, w, h, [r, g, b]) {
	for (let py = y; py < y + h; py++) {
		for (let px = x; px < x + w; px++) {
			const i = (py * raster.width + px) * 4;
			raster.data[i] = r;
			raster.data[i + 1] = g;
			raster.data[i + 2] = b;
			raster.data[i + 3] = 255;
		}
	}
	return raster;
}

/** A white page carrying one black band, standing in for a line of text. */
function pageWithBand(w, h, x, y, bw, bh) {
	return paintRect(solidRaster(w, h), x, y, bw, bh, [0, 0, 0]);
}

report('');
report('Visual comparator: metrics, policy, and negative controls');

/* ── 1. the trivially identical case ──────────────────────────────────────── */

test('identical rasters report zero on every metric', () => {
	const a = pageWithBand(400, 300, 10, 10, 100, 20);
	const r = compareRasters(a, structuredCloneImageData(a));
	assert(r.identical, `expected identical, got MAE ${r.mae}`);
	assert(r.mae === 0, `MAE ${r.mae}`);
	assert(r.max === 0, `MAX ${r.max}`);
	assert(r.changedPixels === 0, `${r.changedPixels} changed pixels`);
	assert(r.changedPct === 0, `changedPct ${r.changedPct}`);
	assert(r.hardPixels === 0, `${r.hardPixels} hard pixels`);
	assert(r.hardPct === 0, `hardPct ${r.hardPct}`);
	assert(r.norm === 0, `norm ${r.norm}`);
	assert(r.pixels === 400 * 300, `pixels ${r.pixels}`);
});

test('identical rasters pass the strict lossless policy', () => {
	const a = solidRaster(200, 200);
	const r = compareRasters(a, structuredCloneImageData(a));
	const v = evaluate(r, policyFor('lossless', false));
	assert(v.ok, `lossless rejected identical pages: ${formatViolations(v.violations)}`);
});

/** Data must be copied so the two rasters are genuinely independent buffers. */
function structuredCloneImageData(r) {
	return { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) };
}

/* ── 2. threshold boundary: what counts as "changed" ──────────────────────── */

test('a 1-unit channel change is below EPSILON and is not a change', () => {
	// Antialiasing wobble must not be reported as visual damage, or every
	// text page would "fail" for reasons no human could see.
	const a = solidRaster(100, 100);
	const b = solidRaster(100, 100);
	b.data[0] = 254; // delta 1, far below EPSILON of 2
	const r = compareRasters(a, b);
	assert(r.changedPixels === 0, `1-unit change counted as ${r.changedPixels} changed pixels`);
	assert(r.max === 1, `MAX ${r.max}`);
	// `identical` is strictly bit-for-bit and ignores EPSILON, so it is false
	// here even though nothing visibly changed. The two fields answer
	// different questions; see the note in scripts/lib/visual.mjs.
	assert(!r.identical, 'bit-exactness should still report a 1-unit change');
	// And lossless must not wave it through either.
	assert(
		!evaluate(r, policyFor('lossless', false)).ok,
		'lossless accepted a sub-EPSILON change; its MAE/MAX bounds should catch it'
	);
});

test(`a change of exactly EPSILON+1 (${EPSILON + 1}) IS a changed pixel`, () => {
	const a = solidRaster(100, 100);
	const b = solidRaster(100, 100);
	b.data[0] = 255 - (EPSILON + 1);
	const r = compareRasters(a, b);
	assert(r.changedPixels === 1, `expected 1 changed pixel, got ${r.changedPixels}`);
	assert(!r.identical, 'should not be identical');
});

test(`a change of exactly EPSILON (${EPSILON}) is NOT a changed pixel`, () => {
	const a = solidRaster(100, 100);
	const b = solidRaster(100, 100);
	b.data[0] = 255 - EPSILON;
	const r = compareRasters(a, b);
	assert(r.changedPixels === 0, `expected 0 changed pixels, got ${r.changedPixels}`);
});

test(`a change of exactly HARD_DELTA (${HARD_DELTA}) IS a hard pixel`, () => {
	const a = solidRaster(50, 50);
	const b = solidRaster(50, 50);
	b.data[0] = 255 - HARD_DELTA;
	const r = compareRasters(a, b);
	assert(r.hardPixels === 1, `expected 1 hard pixel, got ${r.hardPixels}`);
});

test(`a change of HARD_DELTA-1 (${HARD_DELTA - 1}) is NOT a hard pixel`, () => {
	const a = solidRaster(50, 50);
	const b = solidRaster(50, 50);
	b.data[0] = 255 - (HARD_DELTA - 1);
	const r = compareRasters(a, b);
	assert(r.hardPixels === 0, `expected 0 hard pixels, got ${r.hardPixels}`);
});

/* ── 3. THE regression the page mean cannot see ───────────────────────────── */

test('NEGATIVE CONTROL: a missing heading is caught on any document with no re-encodable image', () => {
	// A 300x24 band of black content - a heading - vanishes from an otherwise
	// identical 1000x1000 page. This is the exact scenario the visual stage was
	// built for, and it is the one that actually occurred: a dedupe bug emptied
	// a page that every other suite called correct.
	//
	// A text document has no re-encodable image, so Balanced and Maximum are
	// held to the identical policy too (see `policyFor`). Without that rule the
	// lossy bound would wave this through - MAE here is 0.18, far under 16.
	const original = pageWithBand(1000, 1000, 100, 80, 300, 24);
	const candidate = solidRaster(1000, 1000); // the heading is simply gone
	const r = compareRasters(original, candidate);

	const lossyBound = policyFor('balanced', false, true);
	assert(
		r.mae < lossyBound.mae,
		`test setup wrong: MAE ${r.mae.toFixed(3)} should be under the lossy limit ` +
			`${lossyBound.mae}, otherwise this control is not proving what it claims`
	);

	for (const mode of ['lossless', 'balanced', 'maximum']) {
		const v = evaluate(r, policyFor(mode, false, false)); // no eligible image
		assert(!v.ok, `${mode} accepted a page whose heading vanished (MAE ${r.mae.toFixed(3)})`);
	}
});

test('NEGATIVE CONTROL: a large dropped block is caught even where MAE would pass', () => {
	// The band where hardPct earns its place: high-contrast loss covering a
	// small-ish fraction of a photographic page. MAE is diluted by the large
	// unchanged area and sails under its bound; hardPct does not.
	//
	// 10% of the page changed at delta 96 gives MAE ~9.6 (under the bound of
	// 16) but hardPct 10% (over the bound of 5).
	const W = 1000;
	const H = 1000;
	// The lost block is mid-grey against a black page, so the per-channel delta
	// is 96 - high enough to count as `hard`, but far below the 255 that a
	// blanked page would give. A full delta would drag MAE over its bound and
	// the control would prove nothing about hardPct.
	// Both pages are black overall; only the top tenth of the candidate is grey.
// `solidRaster` starts white, so both rasters are painted black first - leaving
// the rest white would make 90% of the page differ at full delta and drag MAE
// over its bound, which is the failure this control is trying to avoid.
const original = paintRect(solidRaster(W, H), 0, 0, W, H, [0, 0, 0]);
	const candidate = paintRect(paintRect(solidRaster(W, H), 0, 0, W, H, [0, 0, 0]), 0, 0, W, H / 10, [
		96, 96, 96
	]);

	const r = compareRasters(original, candidate);
	const policy = policyFor('balanced', false, true);

	assert(
		r.hardPct > policy.hardPct,
		`test setup wrong: hardPct ${r.hardPct.toFixed(2)} should be over ${policy.hardPct}`
	);
	assert(
		r.mae < policy.mae,
		`test setup wrong: MAE ${r.mae.toFixed(2)} should be under ${policy.mae}`
	);
	const v = evaluate(r, policy);
	assert(!v.ok, `a 10% dropped block was ACCEPTED: MAE ${r.mae.toFixed(2)}, hardPct ${r.hardPct.toFixed(2)}%`);
	assert(
		v.violations.some((x) => x.metric === 'hardPct'),
		`expected the hardPct bound to be what caught it, got ${formatViolations(v.violations)}`
	);
});

test('NEGATIVE CONTROL: a small glyph-level change passes the lossy bound but not the identical policy', () => {
	// The honest boundary of this suite. Damage below ~5% of a photographic
	// page is NOT detectable by these pixel metrics - that is a real limit, not
	// something to paper over. What catches small text damage is the identical
	// policy, applied wherever no image may be re-encoded.
	const W = 1000;
	const H = 1000;
	const original = pageWithBand(W, H, 100, 80, 300, 24);
	const candidate = solidRaster(W, H);
	const r = compareRasters(original, candidate);

	// A text page: strict policy rejects it.
	assert(!evaluate(r, policyFor('balanced', false, false)).ok, 'the strict policy missed a lost heading');

	// But this metric genuinely cannot see it under a loose bound - which is
	// precisely why the strict policy exists rather than a bigger threshold.
	assert(
		r.hardPct < policyFor('balanced', false, true).hardPct,
		`a 300x24 band on 1000x1000 is only ${r.hardPct.toFixed(3)}% of the page; ` +
			'if this ever exceeds the lossy bound the "small damage is undetectable" claim needs revisiting'
	);
});

/* ── 4. other conspicuous damage ──────────────────────────────────────────── */

test('NEGATIVE CONTROL: a shifted element is detected', () => {
	// Same amount of ink, different place. Total error is tiny; the ink is in
	// the wrong column, which `changedPct` sees as old+new changed pixels.
	const original = pageWithBand(600, 400, 50, 100, 120, 40);
	const candidate = pageWithBand(600, 400, 70, 100, 120, 40); // shifted 20px right
	const r = compareRasters(original, candidate);
	const v = evaluate(r, policyFor('lossless', false));
	assert(!v.ok, 'a 20px horizontal shift was ACCEPTED');
	assert(r.changedPixels > 0, 'shift produced no changed pixels at all');
});

test('NEGATIVE CONTROL: a blank replacement page fails every policy', () => {
	const original = pageWithBand(800, 600, 0, 0, 800, 600); // all black
	const candidate = solidRaster(800, 600); // all white
	for (const mode of ['lossless', 'balanced', 'maximum']) {
		for (const hostile of [false, true]) {
			const r = compareRasters(original, candidate);
			const v = evaluate(r, policyFor(mode, hostile));
			assert(!v.ok, `a blanked page was ACCEPTED under ${mode}${hostile ? '/hostile' : ''}`);
		}
	}
});

test('NEGATIVE CONTROL: a blank page fails the most generous bound available', () => {
	// The `hostile` bounds are the loosest in the suite - they exist to
	// tolerate re-encoding noise, not to tolerate losing a page. They must
	// still reject a document whose content vanished entirely.
	const original = pageWithBand(1000, 1000, 0, 0, 1000, 1000);
	const candidate = solidRaster(1000, 1000);
	const r = compareRasters(original, candidate);
	const loosest = policyFor('maximum', true);
	assert(r.mae > loosest.mae, `blanked page MAE ${r.mae} sat under the loosest limit ${loosest.mae}`);
	assert(r.hardPct > loosest.hardPct, `blanked page hardPct ${r.hardPct} sat under the loosest limit ${loosest.hardPct}`);
	assert(!evaluate(r, loosest).ok, 'the loosest policy in the suite accepted a blanked page');
});

/* ── 5. geometry, checked independently of pixels ─────────────────────────── */

test('NEGATIVE CONTROL: different raster dimensions are a geometry failure, not a huge diff', () => {
	const r = compareRasters(solidRaster(100, 100), solidRaster(120, 100));
	assert(r.geometryMismatch, 'size mismatch was not reported as geometry');
	assert(/100x100 vs 120x100/.test(r.reason), `unhelpful reason: ${r.reason}`);
	// Crucially, it must NOT be folded into a pixel score that a threshold
	// could accidentally wave through.
	assert(r.mae === undefined, 'a size mismatch must not produce a MAE');
});

const meta = (n, extra = {}) => ({ page: n, width: 100, height: 100, mediaWidth: 612, mediaHeight: 792, rotate: 0, ...extra });

test('matching page lists pass geometry', () => {
	const g = checkGeometry([meta(1), meta(2)], [meta(1), meta(2)]);
	assert(g.ok, `unexpected geometry problems: ${JSON.stringify(g.problems)}`);
});

test('NEGATIVE CONTROL: a missing page fails document-level geometry', () => {
	const g = checkGeometry([meta(1), meta(2), meta(3)], [meta(1), meta(2)]);
	assert(!g.ok, 'a dropped page was ACCEPTED');
	assert(g.problems[0].kind === 'page-count', `wrong problem kind: ${g.problems[0].kind}`);
	assert(/3 page/.test(g.problems[0].detail) && /2/.test(g.problems[0].detail), g.problems[0].detail);
});

test('NEGATIVE CONTROL: an added page fails document-level geometry', () => {
	const g = checkGeometry([meta(1)], [meta(1), meta(2)]);
	assert(!g.ok, 'an extra page was ACCEPTED');
	assert(g.problems[0].kind === 'page-count', g.problems[0].kind);
});

test('NEGATIVE CONTROL: a reordered page fails on its own content', () => {
	// Page identity is by index, so a swap shows up as two pages whose
	// geometry differs - unless the boxes match, in which case only the pixels
	// can tell, and that is the comparator's job, not geometry's.
	const g = checkGeometry(
		[meta(1, { mediaWidth: 612 }), meta(2, { mediaWidth: 842 })],
		[meta(1, { mediaWidth: 842 }), meta(2, { mediaWidth: 612 })]
	);
	assert(!g.ok, 'pages reordered to different sizes were ACCEPTED');
	assert(g.problems.filter((p) => p.kind === 'page-box').length === 2, 'expected both pages to be flagged');
});

test('NEGATIVE CONTROL: a changed page size fails', () => {
	const g = checkGeometry([meta(1)], [meta(1, { width: 140, height: 100 })]);
	assert(!g.ok, 'a changed rendered page size was ACCEPTED');
	assert(g.problems[0].kind === 'render-size', g.problems[0].kind);
});

test('NEGATIVE CONTROL: a changed MediaBox fails', () => {
	const g = checkGeometry([meta(1)], [meta(1, { mediaWidth: 595 })]);
	assert(!g.ok, 'a changed MediaBox width was ACCEPTED');
	assert(g.problems[0].kind === 'page-box', g.problems[0].kind);
});

test('NEGATIVE CONTROL: a changed /Rotate fails', () => {
	const g = checkGeometry([meta(1)], [meta(1, { rotate: 90 })]);
	assert(!g.ok, 'a changed rotation was ACCEPTED');
	assert(g.problems[0].kind === 'rotation', g.problems[0].kind);
});

test('NEGATIVE CONTROL: a zero-size rendered page is a blank page', () => {
	const g = checkGeometry([meta(1)], [meta(1, { width: 0, height: 0 })]);
	assert(!g.ok, 'a zero-size page was ACCEPTED');
	assert(g.problems.some((p) => p.kind === 'blank-page'), JSON.stringify(g.problems));
});

/* ── 6. geometry tolerance boundary ───────────────────────────────────────── */

test('a media-box delta exactly at the tolerance is accepted', () => {
	const delta = GEOMETRY_TOLERANCE.points;
	const g = checkGeometry([meta(1)], [meta(1, { mediaWidth: 612 + delta })]);
	assert(g.ok, `a delta of exactly the tolerance was rejected: ${JSON.stringify(g.problems)}`);
});

test('a media-box delta just past the tolerance is rejected', () => {
	const delta = GEOMETRY_TOLERANCE.points * 1.0001;
	const g = checkGeometry([meta(1)], [meta(1, { mediaWidth: 612 + delta })]);
	assert(!g.ok, 'a delta past the tolerance was accepted');
});

test('rendered pixel dimensions are compared exactly, with no float tolerance', () => {
	assert(GEOMETRY_TOLERANCE.pixels === 0, 'pixel tolerance should be exactly 0');
	const g = checkGeometry([meta(1)], [meta(1, { width: 101 })]);
	assert(!g.ok, 'a one-pixel geometry change was accepted');
});

/* ── 7. policy plumbing ───────────────────────────────────────────────────── */

test('the identical policy allows nothing, and the lossy policy allows something', () => {
	const strict = policyFor('lossless', false);
	assert(
		strict.mae === 0 && strict.max === 0 && strict.changedPct === 0 && strict.hardPct === 0,
		'the identical policy is not strict'
	);
	for (const mode of ['balanced', 'maximum']) {
		assert(policyFor(mode, false).mae > 0, `${mode}/normal should allow some error`);
		assert(
			policyFor(mode, true).mae >= policyFor(mode, false).mae,
			`${mode}/hostile should not be stricter than ${mode}/normal`
		);
	}
});

test('a document with no re-encodable image is held to the identical policy in every mode', () => {
	// This is the rule that protects text and layout. Measured: every
	// no-re-encode fixture renders at exactly 0.000 in all three modes, so
	// there is no reason to give a lossy bound any room on them - and every
	// reason to think a vanishing heading would slip through without it.
	for (const mode of ['balanced', 'maximum']) {
		assert(
			policyFor(mode, false, false) === policyFor('lossless', false),
			`${mode} on a no-re-encode document should use the identical policy`
		);
		assert(
			policyFor(mode, true, false) === policyFor('lossless', false),
			`${mode}/hostile on a no-re-encode document should use the identical policy`
		);
	}
});

test('balanced and maximum share the same visual policy', () => {
	// Both re-encode eligible JPEGs. They differ in which candidate they pick,
	// not in what they are allowed to do to the page. If that ever stops being
	// true, this test is the thing to update deliberately.
	assert(
		JSON.stringify(policyFor('balanced', false, true)) === JSON.stringify(policyFor('maximum', false, true)),
		'balanced and maximum visual policies have diverged'
	);
});

test('an unknown mode is rejected rather than silently defaulted', () => {
	let threw = false;
	try {
		policyFor('turbo', false);
	} catch {
		threw = true;
	}
	assert(threw, 'policyFor accepted an unknown mode');
});

test('evaluate reports every violated bound, not just the first', () => {
	const original = pageWithBand(200, 200, 0, 0, 200, 200);
	const candidate = solidRaster(200, 200);
	const v = evaluate(compareRasters(original, candidate), policyFor('lossless', false));
	assert(v.violations.length >= 4, `expected several violations, got ${v.violations.length}`);
	const metrics = v.violations.map((x) => x.metric);
	for (const m of ['changedPct', 'hardPct', 'mae', 'max']) {
		assert(metrics.includes(m), `missing violation for ${m}: ${formatViolations(v.violations)}`);
	}
});

/* ── 8. aggregation must not average away one bad page ───────────────────── */

test('aggregate reports the worst page rather than the mean', () => {
	const page = (n, metrics) => ({ page: n, ok: true, metrics });
	const pages = [
		page(1, { pixels: 100, changedPct: 0, hardPct: 0, mae: 0, max: 0 }),
		page(2, { pixels: 100, changedPct: 1, hardPct: 0.1, mae: 1, max: 40 }),
		page(3, { pixels: 100, changedPct: 90, hardPct: 60, mae: 200, max: 255 })
	];
	const agg = aggregate(pages);
	assert(agg.worstHardPage === 3, `worst hard page reported as ${agg.worstHardPage}`);
	assert(agg.worstMaePage === 3, `worst mae page reported as ${agg.worstMaePage}`);
	assert(agg.hardPct === 60, `aggregate hardPct ${agg.hardPct} is an average, not the worst`);
	assert(agg.pages === 3, `pages ${agg.pages}`);
	assert(agg.totalPixels === 300, `totalPixels ${agg.totalPixels}`);
});

test('aggregate of no pages is a benign pass, not a crash', () => {
	const agg = aggregate([]);
	assert(agg.pages === 0 && agg.ok === true, JSON.stringify(agg));
});

/* ── report ───────────────────────────────────────────────────────────────── */

report('');
report(`${passed} passed, ${failed} failed`);
if (failures.length) {
	report('\nFailures:');
	for (const f of failures) report(`  - ${f}`);
}
report('');
process.exit(failed ? 1 : 0);