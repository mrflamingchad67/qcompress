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
import { parseObjects } from './structure';

export interface ImageObject {
	/** Object number. */
	num: number;
	/** Offset of the image's own dictionary, captured at discovery time. */
	dictStart: number;
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
	/**
	 * How the stored payload is wrapped, from the /Filter array.
	 *
	 * This matters more than it looks. `/Filter /DCTDecode` stores a raw JPEG,
	 * but `/Filter [/FlateDecode /DCTDecode]` stores a *Flate-compressed*
	 * JPEG: to recover samples you apply the filters left to right, so the
	 * bytes on disk are the output of the first filter, not of the last.
	 * Handing those to a JPEG decoder fails on every image. Real-world
	 * documents written by Acrobat and similar tools use the wrapped form
	 * routinely.
	 */
	encoding: 'jpeg' | 'flate-jpeg' | null;
	/** JPEG bytes. For 'flate-jpeg' these are still Flate-wrapped. */
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

/** Every filter named under `/key`, whether `/A` or `[/A /B]`. */
const filterList = (dict: string): string[] => {
	const m = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
	if (!m) return [];
	const raw = m[1].trim();
	if (raw.startsWith('[')) {
		return [...raw.matchAll(/\/([A-Za-z0-9]+)/g)].map((x) => x[1]);
	}
	const n = /^\/([A-Za-z0-9]+)/.exec(raw);
	return n ? [n[1]] : [];
};

/**
 * How the stored payload is wrapped, given the /Filter array.
 *
 * Filters run left to right when recovering samples, so the bytes on disk are
 * the *first* filter's output. `null` means the combination is not something
 * this engine is prepared to handle, and the image must be left alone.
 */
function encodingOf(filters: string[]): ImageObject['encoding'] {
	if (!filters.includes('DCTDecode')) return null;
	if (filters.length === 1) return 'jpeg';
	if (filters.length === 2 && filters[0] === 'FlateDecode') return 'flate-jpeg';
	return null;
}

/**
 * Resolve a colour space to what the sample data actually is.
 *
 * A bare `/DeviceRGB` is easy. The common real-world form is
 * `[/ICCBased 171 0 R]`, an ICC profile whose `/N` says how many components the
 * image has. A 3-component profile in an image this engine can re-encode
 * describes RGB data - the profile changes how those components are
 * interpreted, not what they are, so replacing the JPEG leaves the profile
 * exactly as correct as it was.
 *
 * Deliberately conservative: 4 components (CMYK and friends) is NOT treated as
 * safe, because Adobe's APP14 inversion would have to be reproduced exactly and
 * getting it wrong silently swaps colours.
 */
function colorspaceOf(dict: string, objects: Map<number, { dict: string }>): string {
	const direct = /^\/([A-Za-z0-9]+)/.exec(
		/\/ColorSpace\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict)?.[1]?.trim() ?? ''
	);
	if (direct) return direct[1];

	const arr = /\/ColorSpace\s*\[\s*\/?ICCBased\s+(\d+)\s+\d+\s+R\s*\]/.exec(dict);
	if (!arr) return '';

	const profile = objects.get(parseInt(arr[1], 10))?.dict ?? '';
	const n = /\/N\s+(\d+)/.exec(profile)?.[1];
	const alternate = /\/Alternate\s*\/([A-Za-z0-9]+)/.exec(profile)?.[1];

	if (n === '3') return alternate && alternate !== 'DeviceRGB' ? 'ICCBased' : 'DeviceRGB';
	if (n === '1') return alternate && alternate !== 'DeviceGray' ? 'ICCBased' : 'DeviceGray';
	return 'ICCBased';
}

/**
 * Every JPEG (DCTDecode) image XObject in a normalised PDF.
 *
 * `s` must be the latin1 text of a file whose objects are all top-level.
 */
export function findJpegImages(s: string): ImageObject[] {
	const out: ImageObject[] = [];
	const objects = parseObjects(s);
	const header = /(?:^|[\r\n>\]])(\d+)\s+0\s+obj\s*</g;
	let m: RegExpExecArray | null;

	while ((m = header.exec(s)) !== null) {
		const objStart = m.index + m[0].length - 1;
		const dictEnd = matchDict(s, objStart);
		if (dictEnd === -1) continue;
		const dict = s.slice(objStart, dictEnd);

		if (!/\/Subtype\s*\/Image/.test(dict)) continue;
		const encoding = encodingOf(filterList(dict));
		if (!encoding) continue;

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
			dictStart: objStart,
			dataStart,
			length,
			width: num(dict, 'Width') ?? 0,
			height: num(dict, 'Height') ?? 0,
			colorspace: colorspaceOf(dict, objects),
			bitsPerComponent: num(dict, 'BitsPerComponent') ?? 8,
			hasSMask: /\/SMask/.test(dict),
			encoding,
			data: latin1ToBytes(s.slice(dataStart, dataStart + length))
		});
	}
	return out;
}

/** Why an image cannot be re-encoded, or null when it can. */
export function skipReason(img: ImageObject): string | null {
	if (img.encoding === null) return 'unsupported filter chain';
	if (img.width <= 0 || img.height <= 0) return 'missing dimensions';
	if (img.bitsPerComponent !== 8) return `${img.bitsPerComponent}-bit components`;
	if (img.colorspace !== 'DeviceRGB' && img.colorspace !== 'DeviceGray') {
		return `${img.colorspace || 'unknown'} colour space`;
	}
	return null;
}

/** Is this image one we are willing to re-encode? */
export function isReencodable(img: ImageObject): boolean {
	return skipReason(img) === null;
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
		// Use the dictionary offset recorded at discovery. Searching backwards
		// for '<<' is wrong: an image dictionary commonly contains nested
		// dictionaries (/DecodeParms [ null << /Quality 60 >> ]), and the
		// nearest '<<' is that inner one, so /Length would never be found and
		// the payload would be spliced into a stream whose declared length
		// still describes the old data.
		const dictStart = img.dictStart;
		const dictEnd = matchDict(out, dictStart);
		if (dictStart === -1 || dictEnd === -1 || dictEnd > img.dataStart) continue;

		let dict = out.slice(dictStart, dictEnd);

		// New payload length. If /Length cannot be located the replacement is
		// abandoned rather than applied: a stream whose declared length no
		// longer matches its bytes is corrupt, and silently producing one is
		// the single worst outcome this module could have.
		const withLength = dict.replace(/(\/Length\s+)\d+/, `$1${rep.jpeg.length}`);
		if (withLength === dict) continue;
		dict = withLength;

		// Dimensions change when we downscale.
		if (rep.width !== img.width) dict = dict.replace(/(\/Width\s+)\d+/, `$1${rep.width}`);
		if (rep.height !== img.height) dict = dict.replace(/(\/Height\s+)\d+/, `$1${rep.height}`);

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