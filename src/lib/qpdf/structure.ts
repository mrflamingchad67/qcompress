/**
 * Read-only PDF structure reader.
 *
 * Exists because semantic preservation cannot be measured with QPDF's
 * `--json` outside a browser: this WASM build writes its stdout straight to
 * file descriptor 1 via nodefs, so under Bun the JSON is *completely invisible*
 * even when the exit status is 0. (In a browser worker it routes through the
 * console and is capturable — which is why the browser suite can assert on
 * diagnostics and this harness cannot.) Rather than depend on a code path that
 * only behaves in one environment, this reads the structure directly.
 *
 * It answers the questions `--check` cannot:
 *   - how many pages, in what order, at what size and rotation
 *   - which annotations, links, outlines, form fields and metadata exist
 *   - which images exist, with their dimensions and colour spaces
 *
 * Scope and limits, deliberately:
 *   - It parses *flattened* documents (objects at top level, object streams
 *     disabled). That is the invariant the image surgery already relies on,
 *     and it costs the caller one QPDF pass. Parsing cross-reference streams
 *     and object streams would double this module for no gain here.
 *   - It is best-effort and never throws. Anything it cannot resolve is
 *     reported as `null`, which comparison code must treat as "unknown" rather
 *     than as a mismatch - an unreadable field must never become a false
 *     positive.
 */

import { bytesToLatin1 } from './bytes';

export interface RawObject {
	num: number;
	dictStart: number;
	dictEnd: number;
	/** The dictionary text itself, without the `N 0 obj` header. */
	dict: string;
}

export interface PageSummary {
	/** 1-based position in the page tree, which is also the display order. */
	index: number;
	/**
	 * Object number of the page object itself, or null when unknown.
	 *
	 * Identity for *this* document only: QPDF renumbers freely, so this must
	 * never be compared across two files. It exists so a reader can go back to
	 * the object map and resolve the page's own entries (`/Contents`), which
	 * the summary otherwise only reports as a boolean.
	 */
	objNum: number | null;
	/**
	 * Object numbers referenced by `/Contents`, in the order they appear.
	 *
	 * A page has one content stream, or `/Contents` is an array of streams whose
	 * logical content is their concatenation in this order. Empty when the page
	 * has no `/Contents`, which is legal for a genuinely blank page.
	 */
	contentsRefs: number[];
	mediaBox: number[] | null;
	cropBox: number[] | null;
	rotate: number | null;
	/** Annotation subtypes in dictionary order, e.g. ['Link']. */
	annotSubtypes: string[];
	annotCount: number;
	/** External link targets (URI actions), in order. */
	linkUris: string[];
	/** Names of XObjects in the page's resource dictionary, sorted. */
	xobjectNames: string[];
	hasContents: boolean;
	/** True when the page object itself could not be read. */
	unreadable: boolean;
}

export interface ImageSummary {
	width: number | null;
	height: number | null;
	bitsPerComponent: number | null;
	/** e.g. 'DeviceRGB', 'DeviceGray', 'DeviceCMYK', 'ICCBased'. */
	colorspace: string | null;
	/** Stream filter names, e.g. ['DCTDecode']. */
	filters: string[];
	hasSMask: boolean;
}

export interface DocumentSummary {
	/** True when a catalog and a walkable page tree were found. */
	readable: boolean;
	/** Pages actually walked, which is what a comparison should trust. */
	pageCount: number;
	/** /Count declared on the page tree root, when it is a number. */
	declaredCount: number | null;
	pages: PageSummary[];
	/** Outline (bookmark) titles in tree order. */
	outlineTitles: string[];
	hasOutlines: boolean;
	/** AcroForm field names, in document order. */
	formFields: string[];
	hasAcroForm: boolean;
	hasInfo: boolean;
	hasMetadata: boolean;
	hasEncrypt: boolean;
	hasNames: boolean;
	/** Every image XObject, keyed by object number. */
	images: Map<number, ImageSummary>;
	objectCount: number;
}

/* ── tokenising ───────────────────────────────────────────────────────────── */

/** Index just past the `)` closing the literal string at `start`, or -1. */
function matchStringLiteral(text: string, start: number): number {
	let nest = 0;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (c === '\\') {
			i++;
			continue;
		}
		if (c === '(') nest++;
		else if (c === ')') {
			nest--;
			if (nest === 0) return i + 1;
		}
	}
	return -1;
}

/**
 * Index just past the `>>` closing the dict at `start`, or -1.
 *
 * Skips literal strings and hex strings, because their contents are DATA and
 * may contain `<<` or `>>`. A real 10-page document contains thousands of
 * strings; counting a `>>` inside one as a closing brace drove the depth
 * negative, and every object after the first such string was lost.
 */
function matchDict(text: string, start: number): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const c = text[i];

		if (c === '(') {
			// Literal string, with backslash escapes and balanced parentheses.
			let p = i + 1;
			let nest = 1;
			while (p < text.length && nest > 0) {
				if (text[p] === '\\') {
					p += 2;
					continue;
				}
				if (text[p] === '(') nest++;
				else if (text[p] === ')') nest--;
				p++;
			}
			i = p - 1;
			continue;
		}

		if (c === '<' && text[i + 1] !== '<') {
			// Hex string: runs to the next '>', which is data, not a brace.
			const close = text.indexOf('>', i + 1);
			if (close === -1) return -1;
			i = close;
			continue;
		}

		if (c === '<' && text[i + 1] === '<') {
			depth++;
			i++;
			continue;
		}

		if (c === '>' && text[i + 1] === '>') {
			depth--;
			i++;
			if (depth === 0) return i + 1;
			if (depth < 0) return -1;
			continue;
		}
	}
	return -1;
}

/** Index just past the `]` closing the array at `start`, honouring nesting. */
function matchArray(text: string, start: number): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === '[') depth++;
		else if (text[i] === ']') {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/** Index just past the `)` closing the literal string at `start`. */
function matchLiteral(text: string, start: number): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === '\\') {
			i++;
			continue;
		}
		if (text[i] === '(') depth++;
		else if (text[i] === ')') {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/**
 * Read one PDF token starting at `i`.
 *
 * Handles the forms this module needs: arrays, dictionaries, literal strings,
 * hex strings, names and bare tokens (numbers, references).
 */
function readToken(text: string, i: number): string {
	const c = text[i];
	if (c === undefined) return '';

	if (c === '[') {
		const end = matchArray(text, i);
		return end === -1 ? text.slice(i) : text.slice(i, end);
	}
	if (c === '<' && text[i + 1] === '<') {
		const end = matchDict(text, i);
		return end === -1 ? text.slice(i) : text.slice(i, end);
	}
	if (c === '<') {
		const end = text.indexOf('>', i);
		return end === -1 ? text.slice(i) : text.slice(i, end + 1);
	}
	if (c === '(') {
		const end = matchLiteral(text, i);
		return end === -1 ? text.slice(i) : text.slice(i, end);
	}
	if (c === '/') {
		const m = /^\/[^\s/\]<>(){}%]*/.exec(text.slice(i));
		return m ? m[0] : '/';
	}
	if (c === '{') return '{';

	// Bare token: runs until a structural delimiter or whitespace.
	let j = i;
	while (j < text.length && !/[\s/\]<>()[{}%]/.test(text[j])) j++;
	return text.slice(i, j);
}

/**
 * The value of `/key` in `dict`, as raw token text.
 *
 * The key must not be followed by an alphanumeric, so `/Color` does not match
 * `/ColorSpace`. Returns null when absent.
 */
export function rawValue(dict: string, key: string): string | null {
	// `\b` would not help here: `/` is not a word character, so match the
	// key and require a delimiter immediately after it.
	const re = new RegExp(`/${key}(?![A-Za-z0-9])`);
	const m = re.exec(dict);
	if (!m) return null;

	let i = m.index + m[0].length;
	while (i < dict.length && /\s/.test(dict[i])) i++;

	const token = readToken(dict, i);
	if (!token) return null;

	// Names, arrays, dicts and strings stand alone. A bare number may be the start
	// of an indirect reference (`5 0 R`), so absorb the generation and the
	// terminating letter too - stopping before the "R" would leave "5 0",
	// which no longer parses as a reference and silently resolves to nothing.
	if (!/^\d+$/.test(token)) return token;

	const parts = [token];
	let j = i + token.length;
	let guard = 0;

	while (guard++ < 4) {
		let k = j;
		while (k < dict.length && /\s/.test(dict[k])) k++;

		const next = readToken(dict, k);
		if (/^\d+$/.test(next)) {
			parts.push(next);
			j = k + next.length;
			continue;
		}
		if (/^[A-Za-z]$/.test(next)) {
			// The generation letter that terminates a reference.
			parts.push(next);
			j = k + next.length;
		}
		break;
	}

	return parts.join(' ');
}

/** A reference like `5 0 R`, as an object number. */
function refOf(value: string | null): number | null {
	if (!value) return null;
	const m = /^(\d+)\s+\d+\s+R$/.exec(value.trim());
	return m ? parseInt(m[1], 10) : null;
}

/** Follow `N 0 R` to that object's dictionary; inline values pass through. */
function deref(value: string | null, objects: Map<number, RawObject>): string | null {
	if (value === null) return null;
	const ref = refOf(value);
	if (ref === null) return value;
	return objects.get(ref)?.dict ?? null;
}

/**
 * Every occurrence of `/key`, as raw tokens.
 *
 * Needed where a key legitimately appears more than once with different
 * meanings: a link action dictionary contains both `/S /URI` (the action
 * subtype, whose *value* is the name `URI`) and `/URI (…)` (the target). Asking
 * for the first match finds the subtype and silently reads "URI" as the
 * destination.
 */
export function rawValues(dict: string, key: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`/${key}(?![A-Za-z0-9])`, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(dict)) !== null) {
		let i = m.index + m[0].length;
		while (i < dict.length && /\s/.test(dict[i])) i++;
		const token = readToken(dict, i);
		if (token) out.push(token);
	}
	return out;
}

/** A numeric value for `key`, or null. */
function numOf(dict: string, key: string): number | null {
	const raw = rawValue(dict, key);
	if (raw === null) return null;
	return /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : null;
}

/** A name value for `key`, without the leading slash. */
function nameOf(dict: string, key: string): string | null {
	const raw = rawValue(dict, key);
	if (raw === null) return null;
	const m = /^\/([A-Za-z0-9_]+)/.exec(raw.trim());
	return m ? m[1] : null;
}

/**
 * A PDF text value for `key`: a name (`/Foo`) or a string (`(Foo)` / `<Foo>`).
 *
 * Field names and annotation titles use both forms interchangeably, so a
 * name-only reader reports empty field names for perfectly valid forms.
 */
function textOf(dict: string, key: string): string | null {
	for (const raw of rawValues(dict, key)) {
		const lit = literalOf(raw);
		if (lit !== null) return lit;
		const n = /^\/([A-Za-z0-9_.]+)/.exec(raw);
		if (n) return n[1];
	}
	return null;
}

/**
 * The first `/key` whose value is a *string*, skipping ones whose value is a
 * name. Used for link targets, where `/S /URI` precedes `/URI (target)`.
 */
function urlOf(dict: string, key: string): string | null {
	for (const raw of rawValues(dict, key)) {
		if (raw.startsWith('(') || raw.startsWith('<')) return literalOf(raw);
	}
	return null;
}

/** An array of numbers, e.g. a MediaBox. Null if any element is not numeric. */
function numbersOf(raw: string | null): number[] | null {
	if (!raw) return null;
	const t = raw.trim();
	if (!t.startsWith('[') || !t.endsWith(']')) return null;
	const parts = t.slice(1, -1).trim().split(/\s+/).filter(Boolean);
	if (!parts.length) return null;
	const nums = parts.map(Number);
	return nums.every(Number.isFinite) ? nums : null;
}

/** Every `/Name` under `key`, whether it is `/A` or `[/A /B]`. */
function allNamesIn(dict: string, key: string): string[] {
	const raw = rawValue(dict, key);
	if (!raw) return [];
	const t = raw.trim();
	if (t.startsWith('[')) return [...t.matchAll(/\/([A-Za-z0-9_]+)/g)].map((m) => m[1]);
	const m = /^\/([A-Za-z0-9_]+)/.exec(t);
	return m ? [m[1]] : [];
}

/** Decode a PDF string (literal or hex) to text, best effort. */
export function literalOf(raw: string | null): string | null {
	if (!raw) return null;
	const t = raw.trim();
	const lit = /^\(([\s\S]*)\)$/.exec(t);
	if (lit) {
		return lit[1].replace(/\\([()\\])/g, '$1').replace(/\\r/g, '\r').replace(/\\n/g, '\n');
	}
	const hex = /^<([0-9A-Fa-f\s]*)>$/.exec(t);
	if (hex) {
		const h = hex[1].replace(/\s+/g, '');
		let out = '';
		for (let i = 0; i + 1 < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
		return out;
	}
	return null;
}

/* ── object scanning ──────────────────────────────────────────────────────── */

/**
 * Every top-level `N 0 obj`.
 *
 * Sequential rather than a bare regex, because a regex would happily match the
 * bytes "3 0 obj" inside a binary stream. A declared /Length is honoured only
 * when an `endstream` really follows it, so a wrong length cannot make the
 * scan skip into the middle of a stream.
 */
export function parseObjects(text: string): Map<number, RawObject> {
	const objects = new Map<number, RawObject>();
	let pos = 0;
	let guard = 0;

	while (pos < text.length && guard++ < 200_000) {
		const m = /(?:^|[\s>\]])(\d+)\s+0\s+obj\b/.exec(text.slice(pos));
		if (!m) break;

		const num = parseInt(m[1], 10);
		const delimLen = m[0][0] >= '0' && m[0][0] <= '9' ? 0 : 1;
		const headerStart = pos + m.index + delimLen;

		/* An object body is not always a dictionary. Real documents contain
		 * bare string objects (`87 0 obj (Adobe) endobj`) and bare array objects
		 * (`88 0 obj [ -988 -486 988 808 ] endobj`). Searching forward for the
		 * next `<<` when the body is not a dictionary swallowed every object in
		 * between - 80 of 197 in one real document, including all 16 of its
		 * /ToUnicode maps. So the body form is inspected directly.
		 *
		 * Whitespace between `obj` and the body is skipped first: the header
		 * index points at the first digit of the object NUMBER, not the body. */
		let bodyStart = pos + m.index + m[0].length;
		while (bodyStart < text.length && (text[bodyStart] === ' ' || text[bodyStart] === '\r' || text[bodyStart] === '\n' || text[bodyStart] === '\t')) {
			bodyStart++;
		}

		const bodyChar = text[bodyStart];

		if (bodyChar === '(') {
			const end = matchStringLiteral(text, headerStart);
			pos = end === -1 ? headerStart + 1 : end;
			continue;
		}

		if (bodyChar === '[') {
			const end = matchArray(text, bodyStart);
			pos = end === -1 ? bodyStart + 1 : end;
			continue;
		}

		if (text.startsWith('stream', bodyStart)) {
			// A stream with no dictionary. Step past its payload if possible.
			let dataStart = bodyStart + 'stream'.length;
			if (text[dataStart] === '\r') dataStart++;
			if (text[dataStart] === '\n') dataStart++;
			const tail = text.indexOf('endobj', dataStart);
			pos = tail === -1 ? dataStart : tail + 6;
			continue;
		}

		if (text[bodyStart] !== '<' || text[bodyStart + 1] !== '<') {
			// Anything else: not a dictionary object we can index. Step past one
			// character and keep scanning rather than searching forward for a brace.
			pos = bodyStart + 1;
			continue;
		}

		const dictStart = bodyStart;
		const dictEnd = matchDict(text, dictStart);
		if (dictEnd === -1) {
			// An unbalanced dictionary. Record nothing for this object and resume
			// scanning after its header, so the objects that follow are still
			// found. Breaking here used to hide the entire rest of the document.
			pos = headerStart + 1;
			continue;
		}

		objects.set(num, { num, dictStart, dictEnd, dict: text.slice(dictStart, dictEnd) });

		// Step past this object's payload so the next match cannot land inside it.
		const streamIdx = text.indexOf('stream', dictEnd);
		const endObjIdx = text.indexOf('endobj', dictEnd);
		let next: number;

		if (streamIdx === -1 || (endObjIdx !== -1 && endObjIdx < streamIdx)) {
			next = endObjIdx === -1 ? dictEnd : endObjIdx;
		} else {
			let dataStart = streamIdx + 6;
			if (text[dataStart] === '\r') dataStart++;
			if (text[dataStart] === '\n') dataStart++;

			const declared = /\/Length\s+(\d+)/.exec(text.slice(dictStart, streamIdx));
			let skip = -1;
			if (declared) {
				const n = parseInt(declared[1], 10);
				const after = text.indexOf('endstream', dataStart + n);
				const gap = text.slice(dataStart + n, after === -1 ? dataStart : after);
				if (after !== -1 && gap.trim().length <= 2) skip = n;
			}
			if (skip === -1) {
				/* /Length was absent or did not validate. Searching for the FIRST
				 * "endstream" is wrong: a stream's payload may contain those
				 * bytes - compressed data does routinely - and landing there
				 * left `pos` inside the payload, so every object after it was
				 * skipped. Only accept an `endstream` actually followed by
				 * `endobj`. */
				let found = -1;
				let probe = dataStart;
				for (let attempts = 0; attempts < 64; attempts++) {
					const at = text.indexOf('endstream', probe);
					if (at === -1) break;
					let after = at + 'endstream'.length;
					if (text[after] === '\r') after++;
					if (text[after] === '\n') after++;
					if (text.startsWith('endobj', after)) {
						found = at;
						break;
					}
					probe = at + 1;
				}
				skip = found === -1 ? 0 : found - dataStart;
			}
			const tail = text.indexOf('endobj', dataStart + skip);
			next = tail === -1 ? dataStart + skip : tail;
		}

		pos = next === -1 ? text.length : next + 6;
	}

	return objects;
}

/* ── the summary ──────────────────────────────────────────────────────────── */

function emptySummary(objectCount = 0): DocumentSummary {
	return {
		readable: false,
		pageCount: 0,
		declaredCount: null,
		pages: [],
		outlineTitles: [],
		hasOutlines: false,
		formFields: [],
		hasAcroForm: false,
		hasInfo: false,
		hasMetadata: false,
		hasEncrypt: false,
		hasNames: false,
		images: new Map(),
		objectCount
	};
}

/**
 * Summarise a flattened PDF.
 *
 * `bytes` may be the document itself, or anything the caller has already run
 * through `--object-streams=disable`.
 */
export function readStructure(bytes: Uint8Array | string): DocumentSummary {
	const text = typeof bytes === 'string' ? bytes : bytesToLatin1(bytes);
	const objects = parseObjects(text);
	if (!objects.size) return emptySummary(0);

	const summary = emptySummary(objects.size);

	const rootMatch = /\/Root\s+(\d+)\s+\d+\s+R/.exec(text);
	const catalog = rootMatch ? objects.get(parseInt(rootMatch[1], 10))?.dict : null;
	if (!catalog) return summary;

	/* Page tree */
	const pagesDict = deref(rawValue(catalog, 'Pages'), objects);
	summary.declaredCount = pagesDict ? numOf(pagesDict, 'Count') : null;

	const pages: PageSummary[] = [];
	const visited = new Set<number>();

	const walk = (dict: string | null, depth: number, objNum: number | null) => {
		if (!dict || depth > 64 || pages.length > 20_000) return;

		const kidsRaw = rawValue(dict, 'Kids');
		if (kidsRaw === null) {
			pages.push(readPage(dict, pages.length + 1, objects, objNum));
			return;
		}

		// /Kids is either an inline array or an indirect reference to one.
		let list: string | null = null;
		const inline = /^\[([\s\S]*)\]$/.exec(kidsRaw.trim());
		if (inline) {
			list = inline[1];
		} else {
			const child = deref(kidsRaw, objects);
			const ci = child ? /^\s*\[([\s\S]*)\]/.exec(child) : null;
			list = ci ? ci[1] : null;
		}
		if (list === null) {
			pages.push(readPage(dict, pages.length + 1, objects, objNum));
			return;
		}

		for (const m of list.matchAll(/(\d+)\s+\d+\s+R/g)) {
			const num = parseInt(m[1], 10);
			if (visited.has(num)) continue; // cycle guard
			visited.add(num);
			const child = objects.get(num);
			// Keep the page in the count even when its object is unreadable,
			// so a lost page shows up as a count difference rather than
			// silently shrinking the document.
			if (!child) {
				pages.push(unreadablePage(pages.length + 1));
				continue;
			}
			walk(child.dict, depth + 1, num);
		}
	};

	if (pagesDict) walk(pagesDict, 0, null);
	summary.pages = pages;
	summary.pageCount = pages.length;

	/* Catalog-level features */
	summary.hasOutlines = rawValue(catalog, 'Outlines') !== null;
	summary.hasNames = rawValue(catalog, 'Names') !== null;
	summary.hasMetadata = rawValue(catalog, 'Metadata') !== null;

	const outlines = deref(rawValue(catalog, 'Outlines'), objects);
	if (outlines) summary.outlineTitles = collectOutlineTitles(outlines, objects, new Set(), 0);

	const acro = deref(rawValue(catalog, 'AcroForm'), objects);
	if (acro) {
		summary.hasAcroForm = true;
		summary.formFields = collectFormFields(rawValue(acro, 'Fields'), objects, 0);
	}

	summary.hasEncrypt = /\/Encrypt\s+\d+\s+\d+\s+R/.test(text);
	summary.hasInfo = /\/Info\s+\d+\s+\d+\s+R/.test(text);

	/* Images */
	for (const obj of objects.values()) {
		if (!/\/Subtype\s*\/Image/.test(obj.dict)) continue;
		summary.images.set(obj.num, {
			width: numOf(obj.dict, 'Width'),
			height: numOf(obj.dict, 'Height'),
			bitsPerComponent: numOf(obj.dict, 'BitsPerComponent'),
			colorspace: nameOf(obj.dict, 'ColorSpace'),
			filters: allNamesIn(obj.dict, 'Filter'),
			hasSMask: rawValue(obj.dict, 'SMask') !== null
		});
	}

	summary.readable = pages.length > 0;
	return summary;
}

function unreadablePage(index: number): PageSummary {
	return {
		index,
		objNum: null,
		contentsRefs: [],
		mediaBox: null,
		cropBox: null,
		rotate: null,
		annotSubtypes: [],
		annotCount: 0,
		linkUris: [],
		xobjectNames: [],
		hasContents: false,
		unreadable: true
	};
}

function readPage(
	dict: string,
	index: number,
	objects: Map<number, RawObject>,
	objNum: number | null
): PageSummary {
	const annotSubtypes: string[] = [];
	const linkUris: string[] = [];
	let annotCount = 0;

	const annotsRaw = rawValue(dict, 'Annots');
	if (annotsRaw) {
		const body = inlineArrayBody(annotsRaw) ?? inlineArrayBody(deref(annotsRaw, objects) ?? '') ?? '';
		const refs = [...body.matchAll(/(\d+)\s+\d+\s+R/g)];
		annotCount = refs.length;
		for (const m of refs) {
			const a = objects.get(parseInt(m[1], 10))?.dict;
			if (!a) continue;
			const sub = nameOf(a, 'Subtype');
			if (sub) annotSubtypes.push(sub);
			const action = deref(rawValue(a, 'A'), objects);
			const uri = action ? urlOf(action, 'URI') : null;
			if (uri) linkUris.push(uri);
		}
	}

	let xobjectNames: string[] = [];
	const resources = deref(rawValue(dict, 'Resources'), objects);
	if (resources) {
		const xo = deref(rawValue(resources, 'XObject'), objects) ?? rawValue(resources, 'XObject');
		if (xo) xobjectNames = [...xo.matchAll(/\/([A-Za-z0-9_]+)\s+\d+\s+\d+\s+R/g)].map((m) => m[1]);
	}

	return {
		index,
		objNum,
		contentsRefs: contentsRefsOf(dict, objects),
		mediaBox: numbersOf(rawValue(dict, 'MediaBox')),
		cropBox: numbersOf(rawValue(dict, 'CropBox')),
		rotate: numOf(dict, 'Rotate'),
		annotSubtypes,
		annotCount,
		linkUris,
		xobjectNames: [...new Set(xobjectNames)].sort(),
		hasContents: rawValue(dict, 'Contents') !== null,
		unreadable: false
	};
}

/**
 * Object numbers behind `/Contents`, in logical order.
 *
 * `/Contents 5 0 R` is one stream. `/Contents [3 0 R 4 0 R]` is several whose
 * content is concatenated in order, and the array itself is usually indirect
 * (`/Contents 6 0 R` pointing at `[3 0 R 4 0 R]`), so both shapes are handled.
 *
 * Returns `[]` both for "no /Contents" and for "/Contents that could not be
 * resolved" - the two are not distinguished here on purpose, because a caller
 * that needs the difference must check the source object itself. Guessing a
 * single stream from an unresolved array would risk reading the wrong bytes.
 */
function contentsRefsOf(dict: string, objects: Map<number, RawObject>): number[] {
	const raw = rawValue(dict, 'Contents');
	if (raw === null) return [];

	const body = inlineArrayBody(raw) ?? inlineArrayBody(deref(raw, objects) ?? '');
	if (body === null) {
		const ref = refOf(raw);
		return ref === null ? [] : [ref];
	}
	return [...body.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => parseInt(m[1], 10));
}

/** Inner text of an `[...]` token, or null if the value is absent or not an array. */
function inlineArrayBody(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const t = raw.trim();
	if (!t.startsWith('[') || !t.endsWith(']')) return null;
	return t.slice(1, -1);
}

function collectOutlineTitles(
	dict: string,
	objects: Map<number, RawObject>,
	seen: Set<number>,
	depth: number
): string[] {
	if (depth > 32) return [];
	const titles: string[] = [];

	let cursorDict = deref(rawValue(dict, 'First'), objects);
	let guard = 0;

	while (cursorDict && guard++ < 4096) {
		titles.push(literalOf(rawValue(cursorDict, 'Title')) ?? '');

		const firstRef = refOf(rawValue(cursorDict, 'First'));
		if (firstRef !== null) {
			if (seen.has(firstRef)) break;
			seen.add(firstRef);
			titles.push(...collectOutlineTitles(cursorDict, objects, seen, depth + 1));
		}

		const nextRef = refOf(rawValue(cursorDict, 'Next'));
		if (nextRef === null) break;
		if (seen.has(nextRef)) break;
		seen.add(nextRef);
		cursorDict = objects.get(nextRef)?.dict ?? null;
	}

	return titles;
}

function collectFormFields(
	raw: string | null,
	objects: Map<number, RawObject>,
	depth: number
): string[] {
	if (!raw || depth > 32) return [];
	const fields: string[] = [];

	const body = inlineArrayBody(raw) ?? inlineArrayBody(deref(raw, objects) ?? '') ?? '';
	for (const m of body.matchAll(/(\d+)\s+\d+\s+R/g)) {
		const f = objects.get(parseInt(m[1], 10))?.dict;
		if (!f) continue;
		fields.push(textOf(f, 'T') ?? '');
		const kids = inlineArrayBody(rawValue(f, 'Kids'));
		if (kids) fields.push(...collectFormFields(kids, objects, depth + 1));
	}

	return fields;
}