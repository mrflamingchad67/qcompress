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

import { findJpegImages, isReencodable, skipReason, applyReplacements, toBytes, type ImageObject } from './images';
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

/**
 * Downscaling options, pinned rather than inherited.
 *
 * `@jsquash/resize` defaults to lanczos3 + premultiply + linearRGB. Calling it
 * with only a width and height silently inherits all three, and none of them was
 * ever chosen by this project - they are simply what the library does by
 * default. Profiling showed resizing to be 60.8% of an image pass, at 291 ms per
 * 3.24-megapixel image, which is far slower than the work justifies.
 *
 * Measured over the real images of the 32-page book (2400x1351 -> 1700x957,
 * 27 images, same encode quality, comparing against what is used today):
 *
 *   inherited defaults                291 ms/image   reference
 *   lanczos3, linearRGB off           185 ms/image   1.52x
 *   triangle, these options            96 ms/image   2.91x, ~7.5% smaller output
 *
 * `triangle` is a two-tap kernel where lanczos3 takes six, and dropping
 * linearRGB avoids an sRGB -> linear -> resize -> linear -> sRGB round trip per
 * pixel. It also produces fewer high-frequency artefacts, so the re-encoded JPEG
 * is smaller as well as cheaper to produce: faster and smaller rather than a
 * trade between them.
 *
 * This deliberately changes pixels, and therefore output bytes and the visual
 * baselines. It is a compression-behaviour decision, not a refactor. Changing
 * any of these three values requires re-running the fidelity and visual suites;
 * see ROADMAP.md. It lives here, rather than in each codec, so the Node harness
 * and the browser worker cannot drift apart - they must agree byte for byte or
 * the suites compare different pipelines.
 */
export const RESIZE_OPTIONS = {
	method: 'triangle',
	premultiply: false,
	linearRGB: false
} as const;

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
	/**
	 * Inflate/deflate, for images stored Flate-wrapped around a JPEG.
	 *
	 * The browser worker has no zlib binding, so this is null there unless a
	 * codec is supplied; wrapped images are then skipped rather than mangled.
	 */
	zip?: ZipCodec;
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
	/** Why some images were left alone, counted by reason. */
	imageSkips: { reason: string; count: number }[];
	/** True when no candidate beat the original. */
	fallback: boolean;
	candidates: { name: string; bytes: number; valid: boolean; lossy: boolean; rejected?: string; ms: number }[];
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
	/**
	 * Why images were left alone, aggregated by reason.
	 *
	 * Without this the only thing a user learns about a document full of
	 * unsupported images is "unchanged", which is honest but useless - it looks
	 * like the compressor gave up rather than like a deliberate decision.
	 */
	skips: { reason: string; count: number }[];
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
	progress?: (stage: string) => void,
	zip: ZipCodec = browserZip
): Promise<ImagePassResult> {
	const none: ImagePassResult = { bytes: null, imagesFound: 0, imagesReplaced: 0, skips: [] };

	// 1. Flatten so every image stream is a top-level object.
	progress?.('Reading images');
	const flat = await run(input, flattenArgs());
	if (!flat.out) return none;
	const flatText = bytesToLatin1(flat.out);

	const images = findJpegImages(flatText);
	const targets = images.filter(isReencodable);

	/** Why each ineligible image was left alone, counted by reason. */
	const tallySkips = (): { reason: string; count: number }[] => {
		const byReason = new Map<string, number>();
		for (const img of images) {
			const why = skipReason(img);
			if (why === null) continue;
			byReason.set(why, (byReason.get(why) ?? 0) + 1);
		}
		return [...byReason].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
	};

	if (!targets.length) return { ...none, imagesFound: 0, skips: tallySkips() };

	// 2. Re-encode each eligible image, one at a time so decoded buffers are
	//    released immediately instead of all being held at once.
	const replace = new Map<number, { num: number; jpeg: Uint8Array; width: number; height: number; originalBytes: number }>();
	const failures: string[] = [];

	for (const img of targets) {
		progress?.('Re-encoding images');
		try {
			const raw = await toRawJpeg(img, zip);
			if (!raw) {
				failures.push(`obj ${img.num}: stored payload is not a decodable JPEG`);
				continue;
			}

			const decoded = await codec.decode(raw);
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

			// Re-wrap so the stored bytes match how this image was stored, then
			// compare like-for-like: a raw JPEG must beat a Flate-wrapped one,
			// not just its uncompressed size.
			const wrapped = await fromRawJpeg(encoded, img.encoding, zip);
			if (!wrapped) {
				failures.push(`obj ${img.num}: could not re-wrap the encoded JPEG`);
				continue;
			}

			if (wrapped.length < img.length) {
				replace.set(img.num, {
					num: img.num,
					jpeg: wrapped,
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
	if (!spliced) return { ...none, imagesFound: targets.length, skips: tallySkips() };

	const repaired = rebuildXref(spliced.text);
	if (!repaired) {
		return { ...none, imagesFound: targets.length, skips: tallySkips(), rejected: 'could not rebuild cross-reference table' };
	}

	// 4. Structural pass over the repaired document, to reclaim whatever the
	//    image rewrite exposed.
	progress?.('Optimising structure');
	const final = await run(toBytes(repaired), structuralArgs('compress'));
	if (!final.out) {
		return { ...none, imagesFound: targets.length, skips: tallySkips(), rejected: 'structural pass failed' };
	}

	return {
		bytes: final.out,
		imagesFound: targets.length,
		imagesReplaced: spliced.applied,
		skips: tallySkips()
	};
}

/**
 * Inflate/deflate for images whose payload is Flate-wrapped.
 *
 * `/Filter [/FlateDecode /DCTDecode]` stores a Flate-compressed JPEG. The
 * dictionary is left exactly as it was - the replacement is deflated again on
 * the way out - so no structural change is made and the filter chain keeps
 * meaning the same thing.
 *
 * A `null` codec means no deflate is available, in which case these images are
 * skipped rather than mangled.
 */
export type ZipCodec = {
	inflate(data: Uint8Array): Promise<Uint8Array>;
	deflate(data: Uint8Array): Promise<Uint8Array>;
} | null;

const browserZip: ZipCodec = null;

/** Unwrap stored bytes to a raw JPEG, or null if the payload is not wrapped. */
async function toRawJpeg(
	img: { encoding: 'jpeg' | 'flate-jpeg' | null; data: Uint8Array },
	zip: ZipCodec
): Promise<Uint8Array | null> {
	if (img.encoding === 'jpeg') return img.data;
	if (img.encoding !== 'flate-jpeg' || !zip) return null;
	try {
		return await zip.inflate(img.data);
	} catch {
		// A payload that claims Flate but is not inflatable is malformed.
		return null;
	}
}

/** Re-wrap a re-encoded JPEG to match how the original was stored. */
async function fromRawJpeg(
	jpeg: Uint8Array,
	encoding: 'jpeg' | 'flate-jpeg' | null,
	zip: ZipCodec
): Promise<Uint8Array | null> {
	if (encoding === 'jpeg') return jpeg;
	if (encoding !== 'flate-jpeg' || !zip) return null;
	try {
		return await zip.deflate(jpeg);
	} catch {
		return null;
	}
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
	const zip = req.zip ?? browserZip;
	const progress = req.progress;
	const candidates: Candidate[] = [];
	let dedupeReason: string | null = null;

	const remember = (name: string, lossy: boolean, out: Uint8Array | null, ms: number, v: { ok: boolean; reason?: string }) => {
		candidates.push({ name, lossy, bytes: out, valid: v.ok, rejected: v.reason, ms });
	};

	/**
	 * Run one strategy, converting a thrown or rejected runner into a failed
	 * candidate rather than an aborted run.
	 *
	 * A strategy that throws must not take the other strategies with it, and it
	 * must never become the selected result. Both are enforced here: the throw
	 * is recorded as the rejection reason and selection continues.
	 */
	const attempt = async (
		name: string,
		lossy: boolean,
		fn: () => Promise<Uint8Array | null>
	): Promise<Uint8Array | null> => {
		const started = Date.now();
		let out: Uint8Array | null = null;
		let reason: string | null = null;
		try {
			out = await fn();
		} catch (err) {
			out = null;
			reason = err instanceof Error ? err.message : String(err);
		}
		const verdict = out ? await validate(out, run) : { ok: false, reason: reason ?? 'no output' };
		remember(name, lossy, out, Date.now() - started, verdict);
		return verdict.ok ? out : null;
	};

	// Candidate 1 - structural compression.
	progress?.('Optimising structure');
	await attempt('structural', false, async () => (await run(bytes, structuralArgs('compress'))).out);

	// Candidate 2 - linearized (also useful when the structural pass regresses).
	await attempt('linearize', false, async () =>
		(await run(bytes, buildArgs({ ...DEFAULT_OPTIONS, mode: 'linearize' }))).out
	);

	// Candidate 3 - deduplicate repeated streams. Lossless, and on documents
	// that stamp one image across many pages it is the biggest single win.
	const deduped = await attempt('dedupe', false, async () => {
		try {
			return await dedupeCandidate(bytes, run, progress);
		} catch (err) {
			dedupeReason = err instanceof Error ? err.message : String(err);
			return null;
		}
	});

	// Candidate 4 - image-aware. Lossy, so only for the lossy modes, and tried at
	// every setting that mode allows.
	const attempts = MODE_ATTEMPTS[mode];
	let imagesReplaced = 0;
	let imagesFound = 0;
	let imageSkips: { reason: string; count: number }[] = [];

	for (const settings of attempts) {
		if (!codec) break;
		const label = `q${settings.quality}`;

		await attempt(`image-aware (${label})`, true, async () => {
			const pass = await optimiseImages(bytes, settings, run, codec, progress, zip);
			imagesFound = Math.max(imagesFound, pass.imagesFound);
			imagesReplaced = Math.max(imagesReplaced, pass.imagesReplaced);
			if (pass.skips.length) imageSkips = pass.skips;
			if (!pass.bytes && pass.rejected) throw new Error(pass.rejected);
			return pass.bytes;
		});
	}

	// Image re-encoding and deduplication do not fight each other: one shrinks
	// the images, the other removes the copies. Running both in sequence takes
	// the larger of the two wins rather than either one alone.
	if (deduped && codec) {
		for (const settings of attempts) {
			await attempt(`dedupe+image (q${settings.quality})`, true, async () => {
				const pass = await optimiseImages(deduped, settings, run, codec, progress, zip);
				return pass.bytes;
			});
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
			imageSkips,
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
			imageSkips,
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
		rejected: c.rejected,
		// Already measured by `remember`; previously discarded. Forwarded so the
		// pipeline can explain where its time went - `bun run profile` reads it.
		// Observability only: nothing selects on this.
		ms: c.ms
	};
}
