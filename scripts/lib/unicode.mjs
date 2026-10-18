/**
 * Turning recorded text operations into characters.
 *
 * WHY THIS IS SEPARATE FROM textlayer.mjs
 *
 * textlayer.mjs answers "what bytes did this page show?". That is the
 * preservation question, and it is answered without reference to fonts.
 *
 * This answers "what characters did this page show?", which cannot be answered
 * without the font: for a Type0 font with /Identity-H encoding the bytes are
 * CIDs, and the same CID is a different character in a different font. Bytes
 * alone cannot distinguish "He" from "XY".
 *
 * WHAT THIS DOES NOT CLAIM
 *
 * It reproduces what a conforming reader derives from the document's own
 * /ToUnicode maps. It does not claim the document's mapping is correct - a
 * wrong CMap in the source stays wrong. What it can prove is that compression
 * did not change what the source said.
 *
 * A page whose font has no /ToUnicode is UNKNOWN, never "no text". Reporting it
 * as empty would be the same conflation this project has been bitten by twice:
 * a failure to decode is not an absence of characters.
 */
import { parseObjects } from '../../src/lib/qpdf/structure.ts';
import { bytesToLatin1 } from '../../src/lib/qpdf/bytes.ts';
import { parseCMap, splitIntoCodes, utf16beToString } from './cmap.mjs';

/**
 * Inflate is injected rather than imported.
 *
 * The harness and the browser reach this code through different paths, and the
 * document's /ToUnicode streams are frequently Flate-wrapped - 8 of 8 in one
 * real document - so skipping compressed maps would mean silently checking
 * nothing on exactly the files that matter most.
 */
let inflate = null;

/**
 * @param {(bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>} fn
 *   Returns the inflated BYTES, synchronously or as a promise. Both are accepted
 *   and both are normalised to latin1 text here.
 *
 *   The normalisation is not decoration. The codec's return type is whatever the
 *   runtime produced: a Buffer under Node, a Uint8Array under `DecompressionStream`.
 *   A Buffer stringifies correctly, but `Uint8Array.prototype.toString` ignores
 *   its argument and yields "120,98,..." - so the CMap parser was handed
 *   comma-separated byte values and produced an EMPTY mapping table with no error
 *   raised anywhere. Every page decoded to nothing, and since nothing was decoded
 *   on either side of a comparison, the comparison passed.
 *
 *   The injected function is also AWAITED. A `Promise` has a `toString`, so an
 *   un-awaited call was stringified to the literal text "Promise { ... }", which
 *   parses as a CMap containing nothing - the same silent emptiness by a different
 *   route.
 */
export function installInflate(fn) {
	inflate = async (input) => {
		/* Normalise BOTH directions. The document is carried as latin1 text, and
		 * Buffer.from(string) defaults to utf8 - so passing that straight to a
		 * zlib binding mangles every byte >= 0x80 and a valid stream fails with
		 * "incorrect header check". The injected function is given BYTES, and
		 * its result comes back as latin1 text. */
		const inBytes = typeof input === 'string' ? Buffer.from(input, 'latin1') : input;

		let out;
		try {
			out = await fn(inBytes);
		} catch (err) {
			throw new Error(err instanceof Error ? err.message : String(err));
		}

		if (typeof out === 'string') return out;
		if (out instanceof Uint8Array) return bytesToLatin1(out);
		throw new Error(`inflate must return bytes or a latin1 string, got ${typeof out}`);
	};
}

/**
 * Byte offset of an object's stream payload, or null.
 *
 * `parseObjects` exposes `dictStart` / `dictEnd` but not the payload offset, so
 * it is derived here the same way the image reader derives it: find `stream`
 * after the dictionary, then consume exactly one EOL.
 *
 * Returns null when the object has no stream, rather than a plausible-looking
 * offset that would decode to garbage.
 */
function streamOffset(flatText, o) {
	if (!o?.dict) return null;
	const at = flatText.indexOf('stream', o.dictEnd);
	if (at === -1) return null;
	if (flatText.indexOf('endobj', o.dictEnd) < at) return null; // no stream before endobj

	let start = at + 'stream'.length;
	if (flatText[start] === '\r') start++;
	if (flatText[start] === '\n') start++;
	return start;
}

/** Decoded body of an object, inflated when the dictionary asks for it. */
async function streamSource(flatText, objects, num) {
	const o = objects.get(num);
	const start = streamOffset(flatText, o);
	if (start === null) return null;

	const len = parseInt(/\/Length\s+(\d+)/.exec(o.dict)?.[1] ?? '0', 10);
	if (!len) return null;

	const raw = flatText.slice(start, start + len);
	if (!/\/Filter/.test(o.dict)) return raw;
	if (!inflate) return null;

	try {
		/* `inflate` is async and already normalises its result to latin1 text
		 * (see `installInflate`). Both facts are load-bearing: an un-awaited call
		 * stringified a Promise into "Promise { ... }", which parses as a CMap
		 * holding nothing, and a synchronous try/catch could not see the rejection
		 * at all. Either way the page silently decoded to no characters. */
		return await inflate(raw);
	} catch {
		// A stream this cannot read is skipped, not guessed at. The caller sees
		// a missing CMap and reports the page as unknown.
		return null;
	}
}

/**
 * Map from font resource name (e.g. `/F1`) to its parsed CMap, for one page.
 *
 * Resolves the page's /Font resource dictionary, follows each font's
 * /ToUnicode, and parses it. A font with no /ToUnicode is simply absent from
 * the map, which callers must treat as unknown rather than empty.
 *
 * @param {string} flatText  latin1 text of a flattened document
 * @param {{dict: string}} page
 */
export async function fontCMapsForPage(flatText, page) {
	const objects = parseObjects(flatText);
	const out = new Map();

	const pageDict = page?.dict ?? '';

	/* /Resources may be inline or an indirect reference. A real 10-page
	 * document used `/Resources 15 0 R` on every page, and reading /Font
	 * straight out of the page dictionary found nothing - 16 populated CMaps
	 * and not a single decodable page. Both forms are followed. */
	let resourcesDict = null;

	const resInline = /\/Resources\s*<<([\s\S]*?)>>\s*(?:\/|$)/.exec(pageDict);
	if (resInline) resourcesDict = resInline[1];

	if (!resourcesDict) {
		const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(pageDict);
		if (!resRef) return out;
		resourcesDict = objects.get(parseInt(resRef[1], 10))?.dict ?? null;
		if (!resourcesDict) return out;
	}

	/* /Font, within those resources, may itself be inline or referenced. */
	let fontsDict = null;

	const fontInline = /\/Font\s*<<([^>]*)>>/.exec(resourcesDict);
	if (fontInline) fontsDict = fontInline[1];

	if (!fontsDict) {
		const fontRef = /\/Font\s+(\d+)\s+0\s+R/.exec(resourcesDict);
		if (!fontRef) return out;
		fontsDict = objects.get(parseInt(fontRef[1], 10))?.dict ?? null;
		if (!fontsDict) return out;
	}

	/* RawObject carries only the dictionary TEXT, so the /F1 -> obj mapping is
	 * read out of it rather than off a parsed property that does not exist. */
	const entries = fontsDict.matchAll(/\/([A-Za-z0-9#._+-]+)\s+(\d+)\s+0\s+R/g);

	for (const m of entries) {
		const name = `/${m[1]}`;
		const fontObj = objects.get(parseInt(m[2], 10));
		const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(fontObj?.dict ?? '');
		if (!tu) continue;

		const source = await streamSource(flatText, objects, parseInt(tu[1], 10));
		if (source === null) continue;
		out.set(name, parseCMap(source));
	}
	return out;
}

/**
 * Decode one text operation into characters.
 *
 * @returns {{text:string, unmapped:number, fontless:boolean, noCMap:boolean}}
 *   `unmapped` counts codes with no /ToUnicode entry - a genuine gap in the
 *   document, reported rather than hidden. `fontless` means no font was selected;
 *   `noCMap` means a font was selected but has no /ToUnicode. Neither is text.
 */
export function decodeOp(op, cmaps) {
	/* The tokenizer records the bare name (`F1`) while resource dictionaries
	 * key on the PDF form (`/F1`). Normalise both to a leading slash, or every
	 * lookup misses and the document decodes to nothing while every test passes. */
	const raw = op.font?.name ?? null;
	const fontName = raw === null ? null : raw.startsWith('/') ? raw : `/${raw}`;
	const cmap = fontName ? cmaps.get(fontName) : undefined;

	if (!cmap) return { text: '', unmapped: 0, fontless: !fontName, noCMap: Boolean(fontName) };

	let text = '';
	let unmapped = 0;

	for (const s of op.strings) {
		const codes = splitIntoCodes(s, cmap);
		if (codes === null) continue; // code space unknown; not decodable
		for (const code of codes) {
			if (code === null) {
				unmapped++;
				continue;
			}
			const target = cmap.toUnicode.get(code);
			if (target === undefined) {
				unmapped++;
				continue;
			}
			text += utf16beToString(target);
		}
	}
	return { text, unmapped, fontless: false, noCMap: false };
}

/**
 * Decode every operation on a page.
 *
 * @returns {{text:string, unmapped:number, fontless:number, noCMap:number, ops:number}}
 */
export function decodePage(ops, cmaps) {
	let text = '';
	let unmapped = 0;
	let fontless = 0;
	let noCMap = 0;

	for (const op of ops) {
		const r = decodeOp(op, cmaps);
		if (r.fontless) fontless++;
		if (r.noCMap) noCMap++;
		unmapped += r.unmapped;
		text += r.text;
	}
	return { text, unmapped, fontless, noCMap, ops: ops.length };
}