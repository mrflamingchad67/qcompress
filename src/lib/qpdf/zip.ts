/**
 * Bounded Flate codec.
 *
 * This lives apart from the worker so that the tests exercise the SAME inflate
 * the browser runs. A Node-only twin of browser code is how a limit gets
 * implemented twice and only one of them enforced; `bun run test:resource-limits`
 * imports this module directly, and Node and Bun both provide
 * `DecompressionStream`, `Blob` and `Response`.
 */

import type { ZipCodec } from './pipeline';

/**
 * Ceiling on the output of a single inflate.
 *
 * Flate can expand by ~1032:1, so a modest document can ask for gigabytes of
 * decoded samples. That is an allocation failure rather than a catchable error:
 * nothing downstream recovers from it, and in a worker it takes the tab with it.
 *
 * Measured before this limit existed: a 100 KB page-content stream decoded to
 * 100 MB and added 156 MB of heap, and QPDF accepted the file. Scaling that, a
 * 10 MB PDF would have asked for roughly 10 GB.
 *
 * 128 MB sits far above anything this tool must actually handle - a 600 DPI A4
 * scan is about 26 MB of raw samples - so the ceiling rejects only payloads that
 * are already pathological.
 *
 * Exceeding it THROWS rather than truncating. Callers (`toRawJpeg` in the
 * pipeline, the page extractor in the test tooling) already treat a failed
 * inflate as "leave this payload exactly as it was", so the image is skipped
 * instead of being replaced by a truncated prefix - which would be a corrupt
 * JPEG, the one outcome that must never happen.
 */
export const MAX_INFLATE_BYTES = 128 * 1024 * 1024;

/**
 * Join accumulated chunks, or return null if the total is past `limit`.
 *
 * Total is measured before allocating, so the concatenation itself cannot be
 * what exhausts memory.
 */
function concatBounded(chunks: Uint8Array[], limit: number): Uint8Array | null {
	let total = 0;
	for (const c of chunks) total += c.byteLength;
	if (total > limit) return null;

	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

/**
 * Decompress incrementally, abandoning the stream once the ceiling is passed.
 *
 * Reading to completion with `new Response(stream).arrayBuffer()` would have
 * already allocated the whole bomb before any check could run, so the chunks are
 * counted as they arrive and the reader is cancelled the moment the total is
 * too large.
 */
async function inflateBounded(data: Uint8Array, limit: number): Promise<Uint8Array> {
	const reader = new Blob([data as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream('deflate'))
		.getReader();

	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				throw new Error(
					`inflated stream exceeds the ${limit} byte ceiling (${total} and counting); the payload was left untouched`
				);
			}
			chunks.push(value);
		}
	} finally {
		// Releases the decompressor on both the success and the over-cap path.
		await reader.cancel().catch(() => {});
	}

	const joined = concatBounded(chunks, limit);
	if (joined === null) {
		throw new Error(`inflated stream exceeds the ${limit} byte ceiling`);
	}
	return joined;
}

/**
 * The browser codec.
 *
 * Returns null when the runtime lacks `DecompressionStream` / `CompressionStream`,
 * which is the signal every caller already handles by skipping such images
 * rather than corrupting them.
 */
export function makeZip(): ZipCodec {
	if (typeof DecompressionStream === 'undefined' || typeof CompressionStream === 'undefined') {
		return null;
	}
	return {
		inflate: (data) => inflateBounded(data, MAX_INFLATE_BYTES),
		async deflate(data) {
			const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
			return new Uint8Array(await new Response(stream).arrayBuffer());
		}
	};
}