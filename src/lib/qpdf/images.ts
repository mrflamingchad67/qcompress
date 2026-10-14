/**
 * Image XObject discovery and surgical replacement.
 *
 * Why byte surgery instead of a PDF library:
 *
 * A full PDF round-trip (pdf-lib et al.) re-serialises every object, which
 * risks dropping features this app promises to preserve (annotations, forms,
 * optional content, embedded files). Instead we run QPDF once to normalise the
 * file so every object is top-level, then replace *only* the bytes of image
 * streams we deliberately re-encode. Every other byte of the document is left
 * exactly as QPDF wrote it.
 *
 * Scope is deliberately narrow:
 *   - only /DCTDecode (JPEG) streams - already-compressed formats we cannot
 *     improve losslessly are left alone
 *   - only /DeviceRGB and /DeviceGray colour spaces - CMYK JPEGs need Adobe
 *     APP14 inversion handling and are skipped rather than risk corrupting them
 *   - /SMask (transparency) is never touched; the alpha channel stays intact
 *
 * PDF syntax is binary but ASCII-compatible, so a latin1 string round-trips
 * byte-exactly. Working in one keeps offsets trivial and lossless; see
 * ./bytes.ts for the conversions.
 */

import { bytesToLatin1, latin1ToBytes } from './bytes';

export interface ImageObject {
	/** Object number. */
	num: number;
	/** Offset of `stream\n` end, i.e. where the payload begins. */
	dataStart: number;
	/** Declared payload length from /Length. */
	length: number;
	width: number;
	height: number;
	colorspace: string;
	bitsPerComponent: number;
	/** True when the image carries a separate soft mask (transparency). */
	hasSMask: boolean;
	/** JPEG bytes. */
	data: Uint8Array;
}

/** Find the index just past the `>>` that closes the dict starting at `start`. */
function matchDict(s: string, start: number): number {
	let depth = 0;
	for (let i = start; i < s.length; i++) {
		const c = s[i];
		if (c === '<' && s[i + 1] === '<') {
			depth++;
			i++;
		} else if (c === '>' && s[i + 1] === '>') {
			depth--;
			i++;
			if (depth === 0) return i + 1;
		} else if (c === 's' && s.startsWith('stream', i)) {
			// `stream` keyword ends the dict - malformed, bail out.
			return -1;
		}
	}
	return -1;
}

const num = (dict: string, key: string): number | null => {
	const m = new RegExp(`/${key}\\s+(\\d+)`).exec(dict);
	return m ? parseInt(m[1], 10) : null;
};

const token = (dict: string, key: string): string | null => {
	const m = new RegExp(`/${key}\\s*(?:\\[\\s*)?/?([A-Za-z0-9]+)`).exec(dict);
	return m ? m[1] : null;
};

/**
 * Every JPEG (DCTDecode) image XObject in a normalised PDF.
 *
 * `s` must be the latin1 text of a file whose objects are all top-level.
 */
export function findJpegImages(s: string): ImageObject[] {
	const out: ImageObject[] = [];
	const header = /(?:^|[\r\n>\]])(\d+)\s+0\s+obj\s*</g;
	let m: RegExpExecArray | null;

	while ((m = header.exec(s)) !== null) {
		const objStart = m.index + m[0].length - 1;
		const dictEnd = matchDict(s, objStart);
		if (dictEnd === -1) continue;
		const dict = s.slice(objStart, dictEnd);

		if (!/\/Subtype\s*\/Image/.test(dict)) continue;
		if (!/\/DCTDecode/.test(dict)) continue;

		// stream keyword, then exactly one EOL, then the payload.
		const afterDict = s.indexOf('stream', dictEnd);
		if (afterDict === -1) continue;
		let dataStart = afterDict + 'stream'.length;
		if (s[dataStart] === '\r') dataStart++;
		if (s[dataStart] === '\n') dataStart++;

		const length = num(dict, 'Length');
		if (length === null || length <= 0) continue;
		if (dataStart + length > s.length) continue;

		out.push({
			num: parseInt(m[1], 10),
			dataStart,
			length,
			width: num(dict, 'Width') ?? 0,
			height: num(dict, 'Height') ?? 0,
			colorspace: token(dict, 'ColorSpace') ?? '',
			bitsPerComponent: num(dict, 'BitsPerComponent') ?? 8,
			hasSMask: /\/SMask/.test(dict),
			data: latin1ToBytes(s.slice(dataStart, dataStart + length))
		});
	}
	return out;
}

/** Is this image one we are willing to re-encode? */
export function isReencodable(img: ImageObject): boolean {
	if (img.width <= 0 || img.height <= 0) return false;
	if (img.bitsPerComponent !== 8) return false;
	// CMYK needs Adobe APP14 inversion; skip rather than corrupt.
	const cs = img.colorspace;
	if (cs !== 'DeviceRGB' && cs !== 'DeviceGray') return false;
	return true;
}

export interface Replacement {
	/** Object number. */
	num: number;
	/** New JPEG payload. */
	jpeg: Uint8Array;
	width: number;
	height: number;
	originalBytes: number;
}

/**
 * Produce a new document with the given images replaced.
 *
 * Only applies a replacement when it is actually smaller, so a re-encode can
 * never make the file worse.
 */
export function applyReplacements(
	s: string,
	images: ImageObject[],
	replace: Map<number, Replacement>
): { text: string; applied: number; bytesSaved: number } | null {
	// Newest first so earlier offsets stay valid as we edit.
	const targets = images
		.filter((img) => replace.has(img.num))
		.map((img) => ({ img, rep: replace.get(img.num)! }))
		.filter(({ img, rep }) => rep.jpeg.length < img.length)
		.sort((a, b) => b.img.dataStart - a.img.dataStart);

	if (!targets.length) return null;

	let out = s;
	let applied = 0;
	let bytesSaved = 0;

	for (const { img, rep } of targets) {
		const dictStart = out.lastIndexOf('<<', img.dataStart);
		const dictEnd = matchDict(out, dictStart);
		if (dictStart === -1 || dictEnd === -1 || dictEnd > img.dataStart) continue;

		let dict = out.slice(dictStart, dictEnd);
		const oldDict = dict;

		// New payload length.
		dict = dict.replace(/(\/Length\s+)\d+/, `$1${rep.jpeg.length}`);

		// Dimensions change when we downscale.
		if (rep.width !== img.width) dict = dict.replace(/(\/Width\s+)\d+/, `$1${rep.width}`);
		if (rep.height !== img.height) dict = dict.replace(/(\/Height\s+)\d+/, `$1${rep.height}`);

		if (dict === oldDict && rep.jpeg.length === img.length) continue;

		const payload = bytesToLatin1(rep.jpeg);
		// Replace the dict, then swap exactly the declared payload. Everything
		// between the dict end and the payload (the `stream` keyword and its
		// EOL) must be preserved, and everything after the payload is untouched.
		out =
			out.slice(0, dictStart) +
			dict +
			out.slice(dictEnd, img.dataStart) +
			payload +
			out.slice(img.dataStart + img.length);

		applied++;
		bytesSaved += img.length - rep.jpeg.length;
	}

	if (!applied) return null;
	return { text: out, applied, bytesSaved };
}

/** Convert a PDF byte string into bytes. */
export const toBytes = latin1ToBytes;