/**
 * In-page rendering harness. Loaded by Chromium; not part of any test's logic.
 *
 * This file is served to the browser and imported there. It owns the PDF.js
 * document/page/canvas lifecycle and exposes a small imperative API on
 * `window.VISUAL` so the Node-side suite can drive it with `page.evaluate`.
 *
 * Design notes
 *
 * - Comparison happens IN the page, on the rasters that are already resident.
 *   Transferring a 1.5x-scaled letter page back over CDP costs ~4 MB of
 *   base64 per page; across a 40-fixture x 3-mode run that dominates the test.
 *   Only metrics come back - a few hundred bytes per page.
 *
 * - The comparator itself is imported from /testlib/visual.mjs, the same file
 *   the Node unit tests exercise. The logic that judges a fixture is the logic
 *   that was tested.
 *
 * - Every render awaits `renderTask.promise`, which resolves when painting has
 *   actually finished. Sampling a canvas any earlier reads a partially drawn
 *   page and would report differences that are not there.
 *
 * - Canvases, pages and documents are tracked and released explicitly. A suite
 *   that renders thousands of pages leaks several hundred MB otherwise.
 */
import * as pdfjs from '/pdfjs/pdf.mjs';
import {
	compareRasters,
	evaluate,
	policyFor,
	aggregate,
	checkGeometry,
	HARD_DELTA,
	EPSILON
} from '/testlib/visual.mjs';

// The worker is a separate script; without this PDF.js throws on first use.
pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';

// Deterministic rendering. `standardFontDataUrl` lets PDF.js fall back to its
// own bundled fonts instead of whatever the host happens to have installed,
// which is the difference between a reproducible test and a machine-dependent
// one. `isEvalSupported: false` keeps content scripts from running, so a
// document cannot influence the renderer beyond drawing.
const LOAD_OPTIONS = {
	standardFontDataUrl: '/pdfjs/standard_fonts/',
	cMapUrl: '/pdfjs/cmaps/',
	cMapPacked: true,
	isEvalSupported: false
};

/** id -> { doc, pages: Map<number, {image, meta, canvas}> } */
const registry = new Map();

function decode(b64) {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function mediaBox(page) {
	// `view` is [x0, y0, x1, y1] in PDF user space. Normalise so a reversed
	// box still yields positive width/height for comparison.
	const v = page.view;
	const w = Math.abs(v[2] - v[0]);
	const h = Math.abs(v[3] - v[1]);
	return { mediaWidth: w, mediaHeight: h, box: v };
}

/** Load a PDF and return its page count. Throws on any parse/load failure. */
async function load(id, b64) {
	await dispose(id);
	const task = pdfjs.getDocument({ data: decode(b64), ...LOAD_OPTIONS });
	const doc = await task.promise;
	registry.set(id, { doc, pages: new Map() });
	return doc.numPages;
}

/**
 * Render pages of a loaded document at `scale`, keeping the rasters in the
 * registry for a later compare(). Returns geometry only - never pixels.
 */
async function render(id, scale, pageNumbers) {
	const entry = registry.get(id);
	if (!entry) throw new Error(`document "${id}" is not loaded`);

	const rendered = [];
	for (const n of pageNumbers) {
		const page = await entry.doc.getPage(n);
		const viewport = page.getViewport({ scale });

		// A canvas cannot be 0x0 and PDF.js needs real integers; round once,
		// here, so original and candidate use an identical rounding rule.
		const width = Math.max(1, Math.round(viewport.width));
		const height = Math.max(1, Math.round(viewport.height));

		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });

		// Opaque white, matching what a viewer shows for an unprinted page.
		// Set both ways: the fill covers the canvas before any content draws,
		// and `background` covers regions PDF.js leaves untouched.
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, width, height);

		const task = page.render({ canvasContext: ctx, viewport, background: '#ffffff' });
		await task.promise; // paint is complete only when this resolves

		const image = ctx.getImageData(0, 0, width, height);
		const mb = mediaBox(page);
		const meta = {
			page: n,
			width,
			height,
			rotate: page.rotate,
			mediaWidth: mb.mediaWidth,
			mediaHeight: mb.mediaHeight,
			viewportWidth: viewport.width,
			viewportHeight: viewport.height
		};

		entry.pages.set(n, { image, meta, canvas });
		rendered.push(meta);

		// Release the proxy; the pixels we need are already on the canvas.
		page.cleanup();
	}
	return rendered;
}

/**
 * Compare two loaded documents page by page.
 *
 * Geometry and pixels are judged separately on purpose: a page-count or page
 * size mismatch is a structural failure and must not be averaged together with
 * pixel noise into a single misleading number.
 */
async function compare(idA, idB, mode, hostile, mayReencode, tolerance) {
	const a = registry.get(idA);
	const b = registry.get(idB);
	if (!a || !b) throw new Error('compare: both documents must be loaded and rendered');

	const aMeta = [...a.pages.values()].map((p) => p.meta).sort((x, y) => x.page - y.page);
	const bMeta = [...b.pages.values()].map((p) => p.meta).sort((x, y) => x.page - y.page);

	const geometry = checkGeometry(aMeta, bMeta, tolerance);

	// Page correspondence is undefined after a count mismatch; report the
	// structural failure rather than inventing a pairing.
	if (!geometry.ok && geometry.problems.some((p) => p.kind === 'page-count')) {
		return {
			pageCounts: { original: aMeta.length, candidate: bMeta.length },
			geometry,
			pages: [],
			aggregate: aggregate([]),
			policy: policyFor(mode, hostile, mayReencode)
		};
	}

	const policy = policyFor(mode, hostile, mayReencode);
	const pageResults = [];

	for (const meta of aMeta) {
		const pa = a.pages.get(meta.page);
		const pb = b.pages.get(meta.page);
		if (!pa || !pb) {
			pageResults.push({
				page: meta.page,
				ok: false,
				metrics: { pixels: 0, changedPct: 0, hardPct: 0, mae: 0, max: 0, identical: true },
				violations: [{ metric: 'missing-page', value: 0, limit: 0 }],
				reason: 'candidate page was not rendered'
			});
			continue;
		}

		const metrics = compareRasters(pa.image, pb.image);
		if (metrics.geometryMismatch) {
			pageResults.push({
				page: meta.page,
				ok: false,
				metrics: { pixels: 0, changedPct: 100, hardPct: 100, mae: 255, max: 255, identical: false },
				violations: [{ metric: 'raster-size', value: 0, limit: 0 }],
				reason: metrics.reason
			});
			continue;
		}

		const verdict = evaluate(metrics, policy);
		pageResults.push({
			page: meta.page,
			ok: verdict.ok,
			metrics,
			violations: verdict.violations,
			originalSize: `${meta.width}x${meta.height}`,
			candidateSize: `${pb.meta.width}x${pb.meta.height}`
		});
	}

	return {
		pageCounts: { original: aMeta.length, candidate: bMeta.length },
		geometry,
		pages: pageResults,
		aggregate: aggregate(pageResults),
		policy
	};
}

/**
 * Diagnostic image for a page: original | candidate | difference, stacked.
 *
 * Only called when `--diagnose` is passed or a page fails, so the normal run
 * never pays for PNG encoding and CI logs never carry megabytes of image.
 */
async function diffPng(idA, idB, pageNumber, maxWidth) {
	const a = registry.get(idA);
	const b = registry.get(idB);
	const pa = a?.pages.get(pageNumber);
	const pb = b?.pages.get(pageNumber);
	if (!pa || !pb) throw new Error(`diffPng: page ${pageNumber} not rendered in both documents`);

	const w = pa.meta.width;
	const h = pa.meta.height;
	const band = document.createElement('canvas');
	band.width = w;
	band.height = h * 3;
	const ctx = band.getContext('2d');

	ctx.putImageData(pa.image, 0, 0);
	ctx.putImageData(pb.image, 0, h);

	// Difference layer: unchanged content stays greyscale and faint, anything
	// beyond EPSILON is painted magenta, and anything at/above HARD_DELTA is
	// painted solid so a localised defect is obvious at a glance.
	const out = ctx.createImageData(w, h);
	for (let i = 0; i < pa.image.data.length; i += 4) {
		const r = pa.image.data[i];
		const g = pa.image.data[i + 1];
		const bl = pa.image.data[i + 2];
		let peak = 0;
		for (let c = 0; c < 3; c++) {
			const d = Math.abs(pa.image.data[i + c] - pb.image.data[i + c]);
			if (d > peak) peak = d;
		}
		const grey = 255 - (255 - (r + g + bl) / 3) * 0.15;
		if (peak >= HARD_DELTA) {
			out.data[i] = 255;
			out.data[i + 1] = 0;
			out.data[i + 2] = 255;
		} else if (peak > EPSILON) {
			out.data[i] = 255;
			out.data[i + 1] = 0;
			out.data[i + 2] = 0;
		} else {
			out.data[i] = grey;
			out.data[i + 1] = grey;
			out.data[i + 2] = grey;
		}
		out.data[i + 3] = 255;
	}
	ctx.putImageData(out, 0, h * 2);

	let scale = 1;
	if (maxWidth && w > maxWidth) scale = maxWidth / w;
	if (scale !== 1) {
		const small = document.createElement('canvas');
		small.width = Math.round(w * scale);
		small.height = Math.round(h * 3 * scale);
		const sctx = small.getContext('2d');
		sctx.imageSmoothingEnabled = false; // keep text strokes crisp when downscaled
		sctx.drawImage(band, 0, 0, small.width, small.height);
		return small.toDataURL('image/png');
	}
	return band.toDataURL('image/png');
}

/**
 * Per-page ink coverage: the fraction of pixels that are not near-white.
 *
 * A page that failed to draw its content renders blank, which shows up here as
 * a collapse to ~0 regardless of how the pixel metrics happened to land. Useful
 * on its own when a page "differs" and the question is which side is empty.
 */
async function ink(id) {
	const entry = registry.get(id);
	if (!entry) throw new Error(`document "${id}" is not loaded`);
	const out = [];
	for (const [n, { image, meta }] of [...entry.pages.entries()].sort((a, b) => a[0] - b[0])) {
		let dark = 0;
		const d = image.data;
		for (let i = 0; i < d.length; i += 4) {
			// luminance below 250 counts as "something was drawn here"
			if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 250) dark++;
		}
		out.push({
			page: n,
			width: meta.width,
			height: meta.height,
			inkPct: (100 * dark) / (meta.width * meta.height)
		});
	}
	return out;
}

/** Release canvases and the PDF.js document for one id. */
async function dispose(id) {
	const entry = registry.get(id);
	if (!entry) return;
	entry.pages.clear();
	try {
		await entry.doc.destroy();
	} catch {
		// A document that fails to tear down cleanly must not fail the test.
	}
	registry.delete(id);
}

window.VISUAL = { load, render, compare, diffPng, dispose, ink, HARD_DELTA, EPSILON };