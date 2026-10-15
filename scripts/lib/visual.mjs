/**
 * Page-level visual comparison: metrics, policy, and verdicts.
 *
 * WHY THIS EXISTS
 *
 * Everything else in the test suite reasons about a PDF as data: object
 * counts, stream bytes, decoded image rasters, annotation subtypes. All of
 * that can pass while the *page* is visibly broken - a font that stopped
 * embedding, a glyph that vanished, a line that wrapped differently, a crop
 * applied that was never asked for. None of those show up in a byte diff.
 *
 * So this module compares rendered pixels. It is pure: no Node APIs, no DOM,
 * no imports. The same file is loaded by the comparator unit tests in Node and
 * injected into Chromium by the rendering suite, so the logic under test is
 * literally the logic that judges the fixtures. One implementation, no drift.
 *
 * METRIC DEFINITIONS
 *
 * Both rasters are RGBA8. Alpha is ignored: PDF.js renders onto an opaque
 * white canvas, so alpha is 255 everywhere and comparing it would only add
 * noise. Colour channels R, G and B are compared.
 *
 * Let W, H be the raster dimensions and N = W * H the pixel count.
 * For every pixel p and channel c in {R, G, B}:
 *
 *   d(p, c) = |original[p][c] - candidate[p][c]|          (0-255)
 *
 *   MAE    = SUM d(p, c) / (3N)
 *            Mean absolute error per channel, 0-255. A coarse overall drift.
 *
 *   MAX    = MAX d(p, c)
 *            Largest single-channel error anywhere on the page. Catches one
 *            blown-out region that an average would dilute.
 *
 *   changedPixels = #{ p : max_c d(p, c) > EPSILON }
 *   changedPct    = 100 * changedPixels / N
 *            A pixel counts as changed if ANY channel exceeds EPSILON. EPSILON
 *            exists to absorb sub-quantisation noise; it is deliberately far
 *            below anything a human or a JPEG re-encode produces, so a real
 *            one-unit antialiasing wobble is not reported as a change while a
 *            missing glyph (delta 255) always is.
 *
 *   hardPixels = #{ p : max_c d(p, c) >= HARD_DELTA }
 *   hardPct    = 100 * hardPixels / N
 *            THE LOCALISED REGRESSION DETECTOR. A full-page mean is the wrong
 *            tool for "one character is missing": on a dense text page, a
 *            single dropped glyph moves MAE by less than 0.5 and hides inside
 *            the noise. The same glyph on white paper is a 255-delta region
 *            and is counted here in full. JPEG re-encoding produces small,
 *            scattered deltas; a dropped glyph produces a small, CONTIGUOUS
 *            region of maximal deltas. hardPct separates those two cases where
 *            MAE cannot.
 *
 *   norm    = MAE / 255
 *            Normalised 0-1 difference score, comparable across page sizes.
 *
 * Two fields here answer deliberately different questions, and the difference
 * matters when reading a failure:
 *
 *   changedPixels applies EPSILON, so it reports where the page visibly moved.
 *   identical is strictly bit-for-bit (sum === 0) and ignores EPSILON. A
 *   single 1-unit wobble therefore gives changedPixels 0 with identical false.
 *   That is not a contradiction: one asks "would anyone see this", the other
 *   asks "is this the same buffer". Lossless still rejects such a page, because
 *   its policy bounds MAE and MAX at zero and both are non-zero for any change.
 *
 * Geometry is NOT part of the pixel comparison. A raster of different
 * dimensions is not "very different", it is a different thing, and comparing it
 * channel-wise would be meaningless. `compareRasters` reports the mismatch and
 * stops; callers assert on it separately. See section 3 of the stage brief:
 * geometry is an invariant independent of pixel similarity.
 */

/** Channel deltas at or below this are treated as equal (quantisation noise). */
export const EPSILON = 2;

/**
 * Channel delta at or above this counts toward `hardPct`.
 *
 * 96 is chosen from measurement, not taste: re-encoded JPEG on these fixtures
 * peaks around 20-40 in the flat regions and rarely exceeds 60 on the
 * pathological noise fixtures. Anything at or above 96 is a saturated
 * black-on-white style transition - the signature of ink appearing or
 * disappearing, not of lossy compression.
 */
export const HARD_DELTA = 96;

/** Largest number of pixels we are willing to hold for one page comparison. */
const MAX_PIXELS = 64_000_000; // ~256 MP; a 1.5x letter page is ~1.1 MP.

/**
 * Compare two RGBA rasters of identical dimensions.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray|Buffer}} a original
 * @param {{width:number,height:number,data:Uint8ClampedArray|Buffer}} b candidate
 * @returns {object} metrics; `geometryMismatch` is true when the rasters
 *   cannot legitimately be compared.
 */
export function compareRasters(a, b) {
	if (a.width !== b.width || a.height !== b.height) {
		return {
			geometryMismatch: true,
			reason: `raster size ${a.width}x${a.height} vs ${b.width}x${b.height}`,
			width: a.width,
			height: a.height,
			candidateWidth: b.width,
			candidateHeight: b.height
		};
	}

	const pixels = a.width * a.height;
	const channels = pixels * 3;
	if (pixels > MAX_PIXELS) {
		return { geometryMismatch: true, reason: `page too large to compare: ${pixels} pixels` };
	}

	const ad = a.data;
	const bd = b.data;
	let sum = 0;
	let max = 0;
	let changed = 0;
	let hard = 0;

	for (let i = 0; i < ad.length; i += 4) {
		let pixelMax = 0;
		for (let c = 0; c < 3; c++) {
			const d = Math.abs(ad[i + c] - bd[i + c]);
			sum += d;
			if (d > max) max = d;
			if (d > pixelMax) pixelMax = d;
		}
		if (pixelMax > EPSILON) changed++;
		if (pixelMax >= HARD_DELTA) hard++;
	}

	return {
		geometryMismatch: false,
		width: a.width,
		height: a.height,
		pixels,
		changedPixels: changed,
		changedPct: (100 * changed) / pixels,
		hardPixels: hard,
		hardPct: (100 * hard) / pixels,
		mae: sum / channels,
		max,
		norm: sum / channels / 255,
		identical: sum === 0
	};
}

/**
 * An RGBA raster of one colour, used by the comparator's own tests and by the
 * negative controls. Kept here so a test never has to hand-roll a buffer.
 */
export function solidRaster(width, height, [r, g, b] = [255, 255, 255]) {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = r;
		data[i + 1] = g;
		data[i + 2] = b;
		data[i + 3] = 255;
	}
	return { width, height, data };
}

/**
 * Page correspondence and document-level geometry.
 *
 * Separate from the pixel comparison on purpose: "this document has 4 pages
 * and the candidate has 3" is a structural fact that must fail regardless of
 * how similar the surviving pixels are, and it must never be diluted by an
 * average.
 *
 * @param {Array<object>} original  per-page records from the renderer
 * @param {Array<object>} candidate per-page records from the renderer
 * @param {object} tolerance geometry tolerances (see GEOMETRY_TOLERANCE)
 */
export function checkGeometry(original, candidate, tolerance = GEOMETRY_TOLERANCE) {
	const problems = [];

	if (original.length !== candidate.length) {
		problems.push({
			kind: 'page-count',
			detail: `original has ${original.length} page(s), candidate has ${candidate.length}`
		});
		// Page correspondence is undefined once the counts disagree; stop here.
		return { ok: false, problems };
	}

	const n = Math.min(original.length, candidate.length);
	for (let i = 0; i < n; i++) {
		const o = original[i];
		const c = candidate[i];

		// Rendered pixel dimensions. A mode allowed to re-encode images must
		// still never be allowed to change page geometry.
		if (Math.abs(o.width - c.width) > tolerance.pixels || Math.abs(o.height - c.height) > tolerance.pixels) {
			problems.push({
				kind: 'render-size',
				page: i + 1,
				detail: `rendered ${c.width}x${c.height}, original ${o.width}x${o.height}`
			});
		}

		// PDF user-space geometry (MediaBox / CropBox / Rotate as PDF.js
		// resolved it). Floating point: compare with an explicit tolerance
		// rather than exact equality.
		for (const key of ['mediaWidth', 'mediaHeight']) {
			const ov = o[key];
			const cv = c[key];
			if (typeof ov !== 'number' || typeof cv !== 'number') continue;
			if (Math.abs(ov - cv) > tolerance.points) {
				problems.push({
					kind: 'page-box',
					page: i + 1,
					detail: `${key} ${cv} vs original ${ov} (tolerance ${tolerance.points}pt)`
				});
			}
		}

		if (o.rotate !== undefined && c.rotate !== undefined && o.rotate !== c.rotate) {
			problems.push({ kind: 'rotation', page: i + 1, detail: `/Rotate ${c.rotate}, original ${o.rotate}` });
		}

		// A page that renders to nothing at all is a blank-page failure, not a
		// low-similarity page. Catching it by name makes the failure legible.
		if (c.width === 0 || c.height === 0) {
			problems.push({ kind: 'blank-page', page: i + 1, detail: 'candidate page rendered at zero size' });
		}
	}

	return { ok: problems.length === 0, problems };
}

/**
 * Geometry tolerances, defined once and asserted at their own boundary by the
 * comparator tests.
 *
 * `points` covers PDF user-space geometry, which PDF.js computes through
 * matrix multiplication and is therefore not bit-exact across operations.
 * 0.01pt is a hundredth of a point - 35 microns at 300dpi - far below any
 * layout that could matter, and far above float noise.
 *
 * `pixels` covers rendered raster dimensions, which are integers produced by
 * `Math.round(viewport.width * scale)`. Any difference here is a real
 * difference, so the tolerance is 0 and the comparison is exact. It exists as
 * a named constant so the boundary is testable rather than implicit.
 */
export const GEOMETRY_TOLERANCE = { points: 0.01, pixels: 0 };

/**
 * Visual acceptance policy, by compression mode.
 *
 * These encode what each mode actually promises. They are NOT perceptual
 * quality scores, and a pass does not mean "looks good to a human".
 *
 *   identical  Nothing may change. Lossless always, and also Balanced/Maximum
 *              on a document with no image the lossy path may touch.
 *
 *              PDF.js is deterministic: the same content rendered twice in the
 *              same browser produces identical pixels, so this policy has no
 *              tolerance at all. Measured: all 50 lossless page comparisons
 *              across the 37 valid fixtures came back exactly 0.000 on every
 *              metric. Any non-zero value is a defect, not noise.
 *
 *              Extending it to no-re-encode documents is what protects text
 *              and layout. Those pages measure 0.000 in every mode, so a
 *              generous pixel bound must not be allowed to excuse a vanished
 *              heading or a shifted line on them.
 *
 *   lossy      Balanced and Maximum re-encode eligible JPEGs, which
 *              legitimately changes pixels. Gated on `mae` and `hardPct` ONLY -
 *              see the `lossy` entry below for why `changedPct` and `max` are
 *              reported but not gated.
 *
 *              Calibration sources: `bun run test:visual -- --measure` (150
 *              fixture page comparisons) PLUS two real user documents. The real
 *              documents are what actually settled these bounds, because the
 *              fixtures alone produced numbers that failed on real input.
 *
 *                source              hard%    MAE    notes
 *                oversized-600dpi     3.92   14.59   fixture, maximum
 *                scan-300dpi-q80      2.36   12.53   fixture, maximum
 *                jpeg-large           0.86    5.07   fixture (hostile), maximum
 *                real 32-page book    0.64    3.28   user document, maximum
 *                real 10-page plan    0.00    0.48   user document, maximum
 *
 *              Bounds: hardPct 5 / mae 16 for normal, 8 / 20 for hostile.
 *              `hardPct` is the one that discriminates - it sits near zero for
 *              every page that merely drifted, and rises sharply the moment
 *              content stops being drawn.
 *
 *              With MAE at 16, a loss of high-contrast content covering more
 *              than ~5% of a page escapes MAE but is caught by `hardPct`. That
 *              band is where a blanked region or a large dropped block lives.
 *              The limit this implies, stated plainly: on a page that is mostly
 *              photograph, damage smaller than 5% of the area is NOT reliably
 *              detectable here, and the honest answer is that pixel metrics
 *              cannot see it. The `identical` policy covers that case.
 *
 *   hostile    Retained because the corpus distinguishes those fixtures, but
 *              measurement did NOT justify a tighter page-level bound - the
 *              hostile set is small images, so it moves LESS of the page than
 *              the photographs do. Its bounds are deliberately looser, not
 *              tighter; tightening them would be fitting noise.
 */
export const VISUAL_POLICY = {
	/** Must be pixel-identical. Lossless, or a document with no re-encodable image. */
	identical: {
		group: 'identical',
		changedPct: 0,
		hardPct: 0,
		mae: 0,
		max: 0,
		note: 'nothing on this page may change'
	},
	/**
	 * Balanced / Maximum. Gated on `mae` and `hardPct` ONLY.
	 *
	 * `changedPct` and `max` are deliberately absent rather than set to
	 * convenient values, because neither discriminates on lossy input:
	 *
	 *   changedPct  A real 32-page document re-encoded at q55 measures 89.8%
	 *                changed on its worst page while `mae` is 1.7 and `hardPct`
	 *                is 0.000. Nearly every pixel moved by about two levels:
	 *                that is re-encoding, not damage. The metric is high
	 *                precisely when the page is largest and most photographic,
	 *                so any bound on it either fires on good output or is
	 *                vacuous.
	 *
	 *   max         Reached 255 on that same real document - one pixel, at a
	 *                high-contrast edge. Ordinary JPEG behaviour on a page of
	 *                ~1M pixels. It never caught anything the other two missed.
	 *
	 * Both remain reported in the metric table, because they are useful when a
	 * human reads a failure. They simply are not gates. A bound that cannot
	 * fail is not a check, and a bound that fires on correct output trains
	 * people to ignore the suite.
	 */
	lossy: {
		normal: { group: 'lossy-normal', hardPct: 5, mae: 16 },
		hostile: { group: 'lossy-hostile', hardPct: 8, mae: 20 }
	}
};

/**
 * Pick the policy for a fixture/mode pair.
 *
 * `mayReencode` comes from the fixture manifest. When a document has no image
 * the lossy path is allowed to touch, no mode may alter any pixel, so the
 * strict policy applies even to Balanced and Maximum. That is what protects
 * text and layout: a text page measures exactly 0.000 in every mode, so a
 * generous pixel bound must not be allowed to excuse a vanished heading there.
 *
 * @param {'lossless'|'balanced'|'maximum'} mode
 * @param {boolean} hostile whether the fixture is declared hostile in the manifest
 * @param {boolean} mayReencode whether any image in this fixture may be re-encoded
 */
export function policyFor(mode, hostile, mayReencode = true) {
	// An unknown mode is a bug in the caller, not something to silently treat
	// as lossless. Throwing here is what stops a typo'd mode name from quietly
	// applying strict bounds (or, worse, quietly applying none).
	if (mode !== 'lossless' && mode !== 'balanced' && mode !== 'maximum') {
		throw new Error(`no visual policy for mode "${mode}"`);
	}
	if (mode === 'lossless' || !mayReencode) return VISUAL_POLICY.identical;
	return hostile ? VISUAL_POLICY.lossy.hostile : VISUAL_POLICY.lossy.normal;
}

/**
 * Judge one page's metrics against a policy.
 *
 * Every violated bound is reported, not just the first, so a developer sees
 * the whole picture in one run.
 *
 * @returns {{ok:boolean, violations:Array<{metric:string,value:number,limit:number}>}}
 */
export function evaluate(metrics, policy) {
	const violations = [];

	// Only bounds the policy actually declares are applied. The lossy policies
	// omit `changedPct` and `max` on purpose - see VISUAL_POLICY - so this must
	// skip absent keys rather than compare against undefined, which would make
	// every comparison fail.
	for (const metric of ['changedPct', 'hardPct', 'mae', 'max']) {
		const bound = policy[metric];
		if (typeof bound !== 'number') continue;
		if (metrics[metric] > bound) violations.push({ metric, value: metrics[metric], limit: bound });
	}

	return { ok: violations.length === 0, violations };
}

/** Format violations into one line a CI log can be read from. */
export function formatViolations(violations) {
	return violations.map((v) => `${v.metric}=${v.value.toFixed(2)} > ${v.limit}`).join(', ');
}

/**
 * Aggregate per-page metrics into a document result.
 *
 * Deliberately reports the WORST page rather than an average across pages: a
 * 200-page document where page 7 lost a heading must not be described by the
 * mean of 200 healthy pages. `worstPage` names the page so the failure points
 * somewhere specific.
 */
export function aggregate(pageResults) {
	if (pageResults.length === 0) {
		return { pages: 0, ok: true, worstPage: null, mae: 0, changedPct: 0, hardPct: 0, max: 0 };
	}

	const worst = (metric) =>
		pageResults.reduce((a, p) => (p.metrics[metric] > a.metrics[metric] ? p : a), pageResults[0]);

	const wChanged = worst('changedPct');
	const wHard = worst('hardPct');
	const wMae = worst('mae');
	const wMax = worst('max');

	const totalPixels = pageResults.reduce((n, p) => n + p.metrics.pixels, 0);

	return {
		pages: pageResults.length,
		totalPixels,
		ok: pageResults.every((p) => p.ok),
		worstChangedPage: wChanged.page,
		changedPct: wChanged.metrics.changedPct,
		worstHardPage: wHard.page,
		hardPct: wHard.metrics.hardPct,
		worstMaePage: wMae.page,
		mae: wMae.metrics.mae,
		worstMaxPage: wMax.page,
		max: wMax.metrics.max
	};
}