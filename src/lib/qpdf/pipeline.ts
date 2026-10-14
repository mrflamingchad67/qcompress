/**
 * Compression orchestrator.
 *
 * The engine's central problem is that QPDF only rewrites *structure*. It
 * cannot shrink content that is already entropy-coded, and embedded images are
 * usually most of the file. Measured on realistic fixtures, structural
 * optimisation alone was worth ~0.15% - and often made the file larger.
 *
 * So the pipeline produces several *candidates* and keeps the smallest one that
 * still validates:
 *
 *   1. structural      - QPDF object streams + Flate + recompression
 *   2. linearized      - fast-web-view layout
 *   3. image-aware     - re-encode DCTDecode images, then structural
 *
 * Candidate 3 is lossy and is therefore only ever generated for the `balanced`
 * and `maximum` modes. `lossless` never sees it.
 *
 * Every candidate is validated before it can win, and the original bytes are
 * returned unchanged when nothing helps - a larger output is never presented
 * as a success.
 */

import { findJpegImages, isReencodable, applyReplacements, toBytes, type ImageObject } from './images';
import { rebuildXref } from './xref';
import { dedupeStreams } from './dedupe';
import { bytesToLatin1 } from './bytes';
import { buildArgs, DEFAULT_OPTIONS, type Mode } from './options';

export type QualityMode = 'lossless' | 'balanced' | 'maximum';

/**
 * Runs one qpdf invocation. Injected so tests and the worker share logic.
 *
 * The runner owns credential handling: callers that were given a password bind
 * `--password-file`/`--decrypt` into it, so the pipeline never sees secrets and
 * never builds argv it cannot verify.
 *
 * May be synchronous or asynchronous. In the worker `callMain` blocks, so the
 * shipped runner is synchronous; the test harness awaits the WASM module and
 * returns a promise. The pipeline awaits every call, so both work unchanged.
 */
export type QpdfRunner = (
	bytes: Uint8Array,
	args: string[]
) => QpdfRunResult | Promise<QpdfRunResult>;

export interface QpdfRunResult {
	code: number;
	out: Uint8Array | null;
	diagnostics: string;
}

/** JPEG codec, injected and lazily loaded so it is not bundled when unused. */
export interface ImageCodec {
	decode(jpeg: Uint8Array): Promise<ImageData>;
	encode(image: ImageData, quality: number): Promise<Uint8Array>;
	resize(image: ImageData, width: number, height: number): Promise<ImageData>;
}

export interface ModeSettings {
	/** JPEG quality 1-100. */
	quality: number;
	/** Longest edge in pixels an image may have; 0 disables downscaling. */
	maxLongEdge: number;
}

export const MODE_SETTINGS: Record<QualityMode, ModeSettings | null> = {
	// No image work at all: nothing may degrade.
	lossless: null,
	// Moderate: recompress photographic images, leave oversized scans alone
	// below 2480px (that is ~292 DPI on A4/Letter, i.e. already reasonable).
	balanced: { quality: 78, maxLongEdge: 2480 },
	// Aggressive: recompress harder and cap resolution at ~200 DPI equivalent.
	maximum: { quality: 55, maxLongEdge: 1700 }
};

/**
 * The image settings each mode actually tries, in order.
 *
 * A more aggressive setting does not reliably produce a smaller file: a hard
 * downscale can resample artefacts that cost more bits at a lower JPEG quality,
 * and a source that was already heavily compressed can come out smaller when
 * re-encoded at a *higher* quality (better DCT coefficients beat smaller ones).
 *
 * So `maximum` does not simply mean "quality 55". It means "quality 55, and
 * also quality 78 if that happens to be smaller here" - the orchestrator keeps
 * whichever candidate actually wins, and `maximum` therefore never hands back a
 * larger file than `balanced` would have.
 */
export const MODE_ATTEMPTS: Record<QualityMode, ModeSettings[]> = {
	lossless: [],
	balanced: [MODE_SETTINGS.balanced!],
	maximum: [MODE_SETTINGS.maximum!, MODE_SETTINGS.balanced!]
};

export interface Candidate {
	name: string;
	lossy: boolean;
	bytes: Uint8Array | null;
	valid: boolean;
	rejected?: string;
	ms: number;
}

export interface OptimizeRequest {
	bytes: Uint8Array;
	mode: QualityMode;
	progress?: (stage: string) => void;
}

export interface OptimizeResult {
	bytes: Uint8Array;
	originalBytes: number;
	savedBytes: number;
	percent: number;
	strategy: string;
	lossy: boolean;
	durationMs: number;
	imagesProcessed: number;
	imagesReplaced: number;
	/** True when no candidate beat the original. */
	fallback: boolean;
	candidates: { name: string; bytes: number; valid: boolean; lossy: boolean; rejected?: string }[];
}

/* ── validation ──────────────────────────────────────────────────────────── */

const header = (b: Uint8Array) =>
	b.length > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d; // %PDF-

const tail = (b: Uint8Array) => {
	const n = Math.min(b.length, 4096);
	let s = '';
	for (let i = b.length - n; i < b.length; i++) s += String.fromCharCode(b[i]);
	return s;
};

/** Structural sanity plus a real `qpdf --check`. */
export async function validate(
	bytes: Uint8Array,
	run: QpdfRunner
): Promise<{ ok: boolean; reason?: string }> {
	if (!bytes || bytes.length < 32) return { ok: false, reason: 'output too small to be a PDF' };
	if (!header(bytes)) return { ok: false, reason: 'missing %PDF- header' };
	if (!tail(bytes).includes('%%EOF')) return { ok: false, reason: 'missing %%EOF' };
	const r = await run(bytes, ['--check']);
	if (r.code !== 0 && r.code !== 3) return { ok: false, reason: `qpdf --check exited ${r.code}` };
	return { ok: true };
}

/* ── candidates ──────────────────────────────────────────────────────────── */

function structuralArgs(mode: Mode) {
	return buildArgs({
		mode,
		objectStreams: 'generate',
		compressionLevel: 9,
		recompressFlate: true,
		streamData: 'compress',
		decodeLevel: 'generalized'
	});
}

/** Put every object at top level so image streams can be located and replaced. */
function flattenArgs() {
	return ['--no-warn', '--warning-exit-0', '--object-streams=disable', '--stream-data=preserve'];
}

export interface ImagePassResult {
	bytes: Uint8Array | null;
	imagesFound: number;
	imagesReplaced: number;
	rejected?: string;
}

/**
 * Re-encode the JPEG images in a document.
 *
 * Returns null when the document has nothing we are willing to touch, or when
 * the rewrite could not be made structurally sound.
 */
export async function optimiseImages(
	input: Uint8Array,
	settings: ModeSettings,
	run: QpdfRunner,
	codec: ImageCodec,
	progress?: (stage: string) => void
): Promise<ImagePassResult> {
	const none: ImagePassResult = { bytes: null, imagesFound: 0, imagesReplaced: 0 };

	// 1. Flatten so every image stream is a top-level object.
	progress?.('Reading images');
	const flat = await run(input, flattenArgs());
	if (!flat.out) return none;
	const flatText = bytesToLatin1(flat.out);

	const images = findJpegImages(flatText);
	const targets = images.filter(isReencodable);
	if (!targets.length) return none;

	// 2. Re-encode each eligible image, one at a time so decoded buffers are
	//    released immediately instead of all being held at once.
	const replace = new Map<number, { num: number; jpeg: Uint8Array; width: number; height: number; originalBytes: number }>();
	const failures: string[] = [];

	for (const img of targets) {
		progress?.('Re-encoding images');
		try {
			const decoded = await codec.decode(img.data);
			let out = decoded;
			let width = decoded.width;
			let height = decoded.height;

			if (settings.maxLongEdge > 0) {
				const long = Math.max(width, height);
				if (long > settings.maxLongEdge) {
					const scale = settings.maxLongEdge / long;
					width = Math.max(1, Math.round(width * scale));
					height = Math.max(1, Math.round(height * scale));
					out = await codec.resize(decoded, width, height);
				}
			}

			const encoded = await codec.encode(out, settings.quality);
			if (!encoded || encoded.length === 0) {
				throw new Error('encoder returned no data');
			}
			// Never replace with something bigger.
			if (encoded.length < img.length) {
				replace.set(img.num, {
					num: img.num,
					jpeg: encoded,
					width,
					height,
					originalBytes: img.length
				});
			}
		} catch (err) {
			// An image we cannot handle is simply left alone. The reason is
			// kept so a run that silently re-encodes nothing is explainable.
			failures.push(`obj ${img.num}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (!replace.size) {
		return {
			...none,
			imagesFound: targets.length,
			rejected: failures.length
				? `no image was smaller; ${failures[0]}`
				: 'no image was smaller at this quality'
		};
	}

	// 3. Splice, then rebuild the xref: stream lengths changed, so every
	//    recorded offset is now wrong.
	progress?.('Rebuilding document');
	const spliced = applyReplacements(flatText, images, replace);
	if (!spliced) return { ...none, imagesFound: targets.length };

	const repaired = rebuildXref(spliced.text);
	if (!repaired) {
		return { ...none, imagesFound: targets.length, rejected: 'could not rebuild cross-reference table' };
	}

	// 4. Structural pass over the repaired document, to reclaim whatever the
	//    image rewrite exposed.
	progress?.('Optimising structure');
	const final = await run(toBytes(repaired), structuralArgs('compress'));
	if (!final.out) {
		return { ...none, imagesFound: targets.length, rejected: 'structural pass failed' };
	}

	return {
		bytes: final.out,
		imagesFound: targets.length,
		imagesReplaced: spliced.applied
	};
}

/**
 * Collapse duplicate streams, then run the structural pass.
 *
 * Lossless, and worth doing first: on documents that repeat an image across
 * pages it is the single largest saving available without degrading anything.
 */
async function dedupeCandidate(
	input: Uint8Array,
	run: QpdfRunner,
	progress?: (stage: string) => void
) {
	progress?.('Removing duplicates');
	const flat = await run(input, flattenArgs());
	if (!flat.out) return null;

	const result = dedupeStreams(bytesToLatin1(flat.out));
	if (!result.bytes || !result.duplicatesReplaced) return null;

	// The rewrite changed object sizes, so the cross-reference table has to be
	// regenerated before anything can read the file again.
	progress?.('Optimising structure');
	const final = await run(result.bytes, structuralArgs('compress'));
	return final.out;
}

/* ── orchestrator ────────────────────────────────────────────────────────── */

export async function optimize(
	req: OptimizeRequest,
	run: QpdfRunner,
	codec: ImageCodec | null
): Promise<OptimizeResult> {
	const t0 = Date.now();
	const { bytes, mode } = req;
	const progress = req.progress;
	const candidates: Candidate[] = [];
	let dedupeReason: string | null = null;

	const remember = (name: string, lossy: boolean, out: Uint8Array | null, ms: number, v: { ok: boolean; reason?: string }) => {
		candidates.push({ name, lossy, bytes: out, valid: v.ok, rejected: v.reason, ms });
	};

	// Candidate 1 - structural compression.
	progress?.('Optimising structure');
	let t = Date.now();
	const structural = await run(bytes, structuralArgs('compress'));
	const structuralOut = structural.out;
	remember(
		'structural',
		false,
		structuralOut,
		Date.now() - t,
		structuralOut ? await validate(structuralOut, run) : { ok: false, reason: 'qpdf failed' }
	);

	// Candidate 2 - linearized (also useful when the structural pass regresses).
	t = Date.now();
	const linear = await run(bytes, buildArgs({ ...DEFAULT_OPTIONS, mode: 'linearize' }));
	remember(
		'linearize',
		false,
		linear.out,
		Date.now() - t,
		linear.out ? await validate(linear.out, run) : { ok: false, reason: 'qpdf failed' }
	);

	// Candidate 3 - deduplicate repeated streams. Lossless, and on documents
	// that stamp one image across many pages it is the biggest single win.
	t = Date.now();
	let deduped: Uint8Array | null = null;
	try {
		deduped = await dedupeCandidate(bytes, run, progress);
	} catch (err) {
		deduped = null;
		dedupeReason = err instanceof Error ? err.message : String(err);
	}
	remember(
		'dedupe',
		false,
		deduped,
		Date.now() - t,
		deduped ? await validate(deduped, run) : { ok: false, reason: dedupeReason ?? 'no duplicate streams found' }
	);

	// Candidate 4 - image-aware. Lossy, so only for the lossy modes, and tried at
	// every setting that mode allows.
	const attempts = MODE_ATTEMPTS[mode];
	let imagesReplaced = 0;
	let imagesFound = 0;

	for (const settings of attempts) {
		const label = `q${settings.quality}`;
		if (!codec) break;

		t = Date.now();
		try {
			const pass = await optimiseImages(bytes, settings, run, codec, progress);
			imagesFound = Math.max(imagesFound, pass.imagesFound);
			imagesReplaced = Math.max(imagesReplaced, pass.imagesReplaced);
			remember(
				`image-aware (${label})`,
				true,
				pass.bytes,
				Date.now() - t,
				pass.bytes ? await validate(pass.bytes, run) : { ok: false, reason: pass.rejected ?? 'no image work applied' }
			);
		} catch (err) {
			remember(`image-aware (${label})`, true, null, Date.now() - t, {
				ok: false,
				reason: err instanceof Error ? err.message : String(err)
			});
		}
	}

	// Image re-encoding and deduplication do not fight each other: one shrinks
	// the images, the other removes the copies. Running both in sequence takes
	// the larger of the two wins rather than either one alone.
	if (deduped && codec) {
		for (const settings of attempts) {
			const label = `q${settings.quality}`;
			t = Date.now();
			try {
				const pass = await optimiseImages(deduped, settings, run, codec, progress);
				remember(
					`dedupe+image (${label})`,
					true,
					pass.bytes,
					Date.now() - t,
					pass.bytes ? await validate(pass.bytes, run) : { ok: false, reason: pass.rejected ?? 'no further gain' }
				);
			} catch (err) {
				remember(`dedupe+image (${label})`, true, null, Date.now() - t, {
					ok: false,
					reason: err instanceof Error ? err.message : String(err)
				});
			}
		}
	}

	// Pick the smallest VALID candidate that is no larger than the original.
	// A lossy candidate can only win in a lossy mode, which is guaranteed by
	// construction above, but assert it anyway.
	const eligible = candidates.filter(
		(c) => c.valid && c.bytes && c.bytes.length <= bytes.length && (c.lossy ? mode !== 'lossless' : true)
	);

	const best = eligible.sort((a, b) => a.bytes!.length - b.bytes!.length)[0];

	if (!best || !best.bytes) {
		return {
			bytes,
			originalBytes: bytes.length,
			savedBytes: 0,
			percent: 0,
			strategy: 'none',
			lossy: false,
			durationMs: Date.now() - t0,
			imagesProcessed: imagesFound,
			imagesReplaced,
			fallback: true,
			candidates: candidates.map(summarise)
		};
	}

	return {
		bytes: best.bytes,
		originalBytes: bytes.length,
		savedBytes: bytes.length - best.bytes.length,
		percent: ((bytes.length - best.bytes.length) / bytes.length) * 100,
		strategy: best.name,
		lossy: best.lossy,
		durationMs: Date.now() - t0,
		imagesProcessed: imagesFound,
		imagesReplaced,
		fallback: false,
		candidates: candidates.map(summarise)
	};
}

function summarise(c: Candidate) {
	return {
		name: c.name,
		bytes: c.bytes ? c.bytes.length : 0,
		valid: c.valid,
		lossy: c.lossy,
		rejected: c.rejected
	};
}