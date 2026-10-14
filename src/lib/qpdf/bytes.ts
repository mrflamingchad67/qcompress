/**
 * PDF text handling.
 *
 * PDF is a binary format with ASCII-compatible syntax, so a latin1
 * (ISO-8859-1) string maps one-to-one onto bytes: `charCodeAt` & 0xff is the
 * byte, and `String.fromCharCode` of a byte is the character. Round-tripping
 * through latin1 is therefore lossless and byte-exact, which is what lets the
 * surgery modules work with ordinary string offsets.
 *
 * These are hand-rolled rather than delegated to `Buffer` or `TextDecoder`
 * because the compression engine runs in a browser Web Worker where neither
 * Node's `Buffer` nor a `latin1` TextDecoder label is dependable, and a silent
 * mojibake conversion here would corrupt every document it touched.
 */

/** Convert bytes to a latin1 string. */
export function bytesToLatin1(bytes: Uint8Array): string {
	// Chunked: spreading a multi-megabyte PDF into fromCharCode overflows the
	// argument limit.
	const CHUNK = 0x8000;
	let out = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		out += String.fromCharCode.apply(
			null,
			bytes.subarray(i, i + CHUNK) as unknown as number[]
		);
	}
	return out;
}

/** Convert a latin1 string back to bytes. */
export function latin1ToBytes(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
	return out;
}

/** Do two byte ranges hold identical data? */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** A copy that owns its buffer, safe to transfer or keep past the WASM heap. */
export function detach(view: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(new ArrayBuffer(view.length));
	copy.set(view);
	return copy;
}