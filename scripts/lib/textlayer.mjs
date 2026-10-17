/**
 * Text-layer extraction from PDF page content streams.
 *
 * WHY THIS EXISTS
 *
 * The visual-regression suite proves a page still *looks* right. It says
 * nothing about whether the text under those pixels still exists. A document can
 * render pixel-identical with a shredded text layer: search finds nothing,
 * copy yields nothing, a screen reader has nothing to read.
 *
 * The standing argument has been "we never rewrite content streams, so text
 * corruption is unlikely". That is an architectural expectation, not a test -
 * and it is exactly the reasoning that hid the deduplication bug (see
 * `src/lib/qpdf/dedupe.ts`), where several suites reported success while pages
 * were rendering blank. This module exists so that argument is checked instead
 * of trusted.
 *
 * WHAT IS PRESERVED, EXACTLY
 *
 * The invariant is:
 *
 *   Compression must not remove or alter the ordered string payloads supplied
 *   to a page's text-showing operators.
 *
 * The operators are `Tj`, `TJ`, `'` and `"`. The numeric positioning values in
 * a `TJ` array and in `"` are NOT text and are deliberately excluded: they move
 * glyphs, and the visual suite owns rendered position. This stage is about the
 * payload, not the placement.
 *
 * WHAT THIS DOES NOT PROVE
 *
 * Extracted bytes are *font-encoded*, not Unicode. A string's bytes are mapped
 * to glyphs through the font's encoding and its /ToUnicode CMap, neither of
 * which is consulted here. So this module proves:
 *
 *   - the same bytes reach the same operators, in the same order, per page;
 *   - no text-showing operator, string or `TJ` segment was dropped or altered.
 *
 * It does NOT prove correct Unicode extraction, correct reading order, tagged
 * PDF validity, /ToUnicode correctness, or screen-reader accessibility. Two
 * documents with different encodings and identical visual output can have
 * different extracted bytes here. That is a real limit, stated rather than
 * papered over, and it is why the visual suite still has to run.
 *
 * WHY A TOKENIZER AND NOT A REGEX
 *
 * The bytes `Tj` occur constantly inside JPEG data, comments and string
 * literals. A regex over raw stream bytes finds them there. Nine of the corpus
 * fixtures already contain `)` followed by `"` purely by accident inside image
 * payloads - a regex would happily report those as text-showing operators.
 *
 * The tokenizer below implements the parts of the PDF content-stream grammar
 * that matter here: delimiters, comments, literal strings with escapes and
 * balanced parentheses, hex strings, arrays, numbers, names, dictionaries, and
 * inline images (whose payload must not be scanned at all).
 *
 * DEPENDENCIES
 *
 * None. Stream inflation is injected, so this module stays pure and can run
 * unchanged in Node or a browser worker.
 */

import { bytesToLatin1, latin1ToBytes } from '../../src/lib/qpdf/bytes.ts';
import { parseObjects, readStructure, rawValue } from '../../src/lib/qpdf/structure.ts';

/**
 * The four text-showing operators.
 *
 * @typedef {'Tj'|'TJ'|"'"|'"'} TextOperator
 * @typedef {{op: TextOperator, strings: Uint8Array[]}} TextOp
 * @typedef {{page: number, ops: TextOp[], text: Uint8Array, unsupported: string|null}} PageTextSignature
 * @typedef {{readable: boolean, pageCount: number, pages: PageTextSignature[],
 *            unsupportedPages: Array<{page: number, reason: string}>}} TextSignature
 */
export const TEXT_OPERATORS = ['Tj', 'TJ', "'", '"'];

/**
 * One text-showing operation, in execution order.
 *
 * `strings` holds the decoded bytes for the operation, in order. `Tj`, `'`
 * and `"` always yield exactly one entry. `TJ` yields one per string in its
 * array, with the numeric positioning values between them dropped - so
 * removing one segment from a `TJ` is visible as a missing entry here rather
 * than as a shorter aggregate.
 *
 * A page's `unsupported` is set when its content could not be read or
 * decoded. Never conflate it with "this page has no text": a page whose
 * stream failed to inflate is an unknown page, not an empty one, and
 * conflating them is how corruption becomes a silent pass.
 */

/* ── tokenizer ─────────────────────────────────────────────────────────────── */

/** @typedef {{kind: 'string'|'hex'|'number'|'name'|'operator'|'array-open'|'array-close'|'dict-open'|'dict-close', value: Uint8Array|string}} Token */

const isWhitespace = (c) => c === '\0' || c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === ' ';
const isDelimiter = (c) => '()<>[]{}/%'.includes(c);
const isRegular = (c) => !isWhitespace(c) && !isDelimiter(c);

/**
 * Tokenize a content stream.
 *
 * Follows the PDF content-stream grammar rather than searching for operator
 * names, so an operator is only reported when it is genuinely one: a `Tj`
 * inside a string, a comment or an inline image payload is never a token.
 *
 * Inline images are handled by skipping wholesale from `ID` to the matching
 * `EI`. That is not a general image parser, and does not need to be: the only
 * requirement is that binary payload is never scanned for operators.
 */
export function tokenize(text) {
	/** @type {Token[]} */
	const tokens = [];
	let i = 0;
	// Guards against a malformed stream pinning the loop.
	let guard = 0;

	const limit = text.length;

	while (i < limit && guard++ < 5_000_000) {
		const c = text[i];

		/* Whitespace */
		if (isWhitespace(c)) {
			i++;
			continue;
		}

		/* Comment: % to end of line */
		if (c === '%') {
			while (i < limit && text[i] !== '\n' && text[i] !== '\r') i++;
			continue;
		}

		/* Literal string ( ) */
		if (c === '(') {
			const { bytes, next } = readLiteralString(text, i);
			tokens.push({ kind: 'string', value: bytes });
			i = next;
			continue;
		}

		/* Hex string <>, or a dictionary opener << */
		if (c === '<') {
			if (text[i + 1] === '<') {
				tokens.push({ kind: 'dict-open', value: '<<' });
				i += 2;
				continue;
			}
			const { bytes, next } = readHexString(text, i);
			tokens.push({ kind: 'hex', value: bytes });
			i = next;
			continue;
		}
		if (c === '>') {
			if (text[i + 1] === '>') {
				tokens.push({ kind: 'dict-close', value: '>>' });
				i += 2;
			} else {
				i++; // stray '>' - skip rather than treat as an operator
			}
			continue;
		}

		if (c === '[') {
			tokens.push({ kind: 'array-open', value: '[' });
			i++;
			continue;
		}
		if (c === ']') {
			tokens.push({ kind: 'array-close', value: ']' });
			i++;
			continue;
		}

		/* Name, with #xx escapes */
		if (c === '/') {
			let j = i + 1;
			while (j < limit && isRegular(text[j])) j++;
			tokens.push({ kind: 'name', value: decodeName(text.slice(i + 1, j)) });
			i = j;
			continue;
		}

		/* An operator or a number: a run of regular characters.
		 *
		 * `BI ... ID <bytes> EI` is the one construct whose payload is not
		 * regular characters, so it is intercepted here.
		 */
		let j = i;
		while (j < limit && isRegular(text[j])) j++;
		const word = text.slice(i, j);

		if (word === 'BI') {
			const after = skipInlineImage(text, j);
			i = after;
			continue;
		}

		if (isNumber(word)) {
			tokens.push({ kind: 'number', value: word });
		} else {
			tokens.push({ kind: 'operator', value: word });
		}
		i = j === i ? i + 1 : j;
	}

	return tokens;
}

const isNumber = (w) => /^[+-]?(\d+\.?\d*|\.\d+|\d*\.)$/.test(w);

/**
 * A literal string's decoded bytes.
 *
 * Handles balanced parentheses, the escape sequences the PDF grammar defines,
 * octal escapes of one to three digits, and backslash-newline continuation. A
 * CRLF or LF pair after a backslash is *one* line ending and collapses to
 * nothing, per the specification.
 */
export function readLiteralString(text, start) {
	const out = [];
	let depth = 0;
	let i = start;

	while (i < text.length) {
		const c = text[i];

		if (c === '\\') {
			const e = text[i + 1];
			if (e === undefined) {
				i++;
				continue;
			}
			// Line continuation: a backslash followed by an end of line.
			if (e === '\r') {
				i += text[i + 2] === '\n' ? 3 : 2;
				continue;
			}
			if (e === '\n') {
				i += 2;
				continue;
			}
			// Octal escape: up to three octal digits.
			if (e >= '0' && e <= '7') {
				let v = 0;
				let n = 0;
				while (n < 3 && i + 1 + n < text.length) {
					const d = text[i + 1 + n];
					if (d < '0' || d > '7') break;
					v = v * 8 + (d.charCodeAt(0) - 48);
					n++;
				}
				out.push(v & 0xff);
				i += 1 + n;
				continue;
			}
			const mapped = ESCAPES[e];
			out.push(mapped === undefined ? e.charCodeAt(0) & 0xff : mapped);
			i += 2;
			continue;
		}

		if (c === '(') {
			depth++;
			if (depth > 1) out.push(40); // nested '(' is literal content
			i++;
			continue;
		}

		if (c === ')') {
			depth--;
			if (depth === 0) return { bytes: Uint8Array.from(out), next: i + 1 };
			out.push(41); // the ')' that closed a nested group
			i++;
			continue;
		}

		out.push(c.charCodeAt(0) & 0xff);
		i++;
	}

	// Unterminated. Returning what was read is better than dropping the token:
	// a truncated stream then fails the comparison rather than silently
	// contributing no text.
	return { bytes: Uint8Array.from(out), next: i };
}

const ESCAPES = {
	n: 10,
	r: 13,
	t: 9,
	b: 8,
	f: 12,
	'(': 40,
	')': 41,
	'\\': 92
};

/**
 * A hex string's decoded bytes.
 *
 * Whitespace inside the string is ignored. An odd number of digits is padded
 * with a trailing zero, as the specification requires.
 */
export function readHexString(text, start) {
	let i = start + 1;
	const digits = [];
	while (i < text.length) {
		const c = text[i];
		if (c === '>') break;
		if (!isWhitespace(c)) digits.push(c);
		i++;
	}
	// An odd trailing nibble is completed with 0, so `<4>` is the single byte
	// 0x40 rather than being an error.
	if (digits.length % 2 === 1) digits.push('0');

	const out = new Uint8Array(digits.length >> 1);
	for (let k = 0; k < out.length; k++) {
		const hi = hexVal(digits[k * 2]);
		const lo = hexVal(digits[k * 2 + 1]);
		out[k] = ((hi < 0 || lo < 0 ? 0 : hi) << 4) | (lo < 0 ? 0 : lo);
	}
	return { bytes: out, next: i + 1 };
}

function hexVal(c) {
	const v = parseInt(c, 16);
	return Number.isNaN(v) ? -1 : v;
}

/** `#xx` in a name decodes to the corresponding byte. */
function decodeName(raw) {
	return raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Skip an inline image: from the token after `BI`, past `ID`, then past the
 * binary payload up to the `EI` that closes it.
 *
 * Narrow by design. The payload is arbitrary bytes that may contain anything,
 * including `EI`, so the end is found by scanning for `EI` delimited by
 * whitespace or a delimiter, which is the rule the content-stream syntax
 * actually specifies. This exists only to stop image bytes being scanned for
 * operators; it makes no attempt to validate image data.
 */
function skipInlineImage(text, from) {
	const idIdx = /\bID\b[\s]/.exec(text.slice(from, from + 4096));
	if (!idIdx) return from; // malformed; give up rather than scan blindly

	let i = from + idIdx.index + idIdx[0].length;
	const start = i;

	// Payload ends at a whitespace-delimited `EI`. Bounded so a truncated
	// stream cannot spin.
	const searchEnd = Math.min(text.length, start + 50_000_000);
	while (i < searchEnd) {
		const c = text[i];
		if (isWhitespace(c)) {
			const tail = /^EI(?![A-Za-z0-9])/.exec(text.slice(i + 1, i + 4));
			if (tail) return i + 1 + tail[0].length;
		}
		i++;
	}
	return text.length;
}

/* ── extraction ────────────────────────────────────────────────────────────── */

/**
 * The text-showing operations in one already-decoded content stream.
 *
 * Operates on the concatenation of the page's streams, in logical order, so a
 * page whose `/Contents` is an array is handled the same as a single stream.
 */
export function extractTextOps(streamText) {
	const tokens = tokenize(streamText);
	const ops = [];

	/* The font selected by the most recent `Tf`, as a resource name.
	 *
	 * Needed to turn a string into characters rather than bytes. For a Type0
	 * font with /Identity-H encoding the bytes are CIDs, and the same CID means
	 * different characters in different fonts - so a byte-level comparison
	 * cannot tell "He" from "XY". Recorded ADDITIVELY: `text` and the
	 * byte-preservation guarantee are unchanged, and nothing existing compares
	 * whole operation objects, so this cannot weaken what is already checked.
	 *
	 * Null means no font was selected before this operation, which is an
	 * unknown state rather than "no text" - a conforming reader has no font to
	 * decode with either, and reporting that as empty text would be a lie.
	 */
	let currentFont = null;

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.kind !== 'operator') continue;

		switch (t.value) {
			case 'Tf': {
				// Operands are `fontname size`, so the name is two tokens back.
				const name = tokens[i - 2];
				const size = tokens[i - 1];
				if (name?.kind === 'name') {
					currentFont = { name: name.value, size: size?.kind === 'number' ? size.value : null };
				} else if (name?.kind === 'number') {
					// Malformed order, but a number where the name belongs is
					// still a font selection attempt worth recording.
					currentFont = { name: String(name.value), size: size?.kind === 'number' ? size.value : null };
				}
				break;
			}
			case 'Tj': {
				const operand = tokens[i - 1];
				// A missing or non-string operand is reported as an empty
				// operation rather than invented: the byte payload really is
				// empty, and the comparison will see it as such.
				ops.push({
					op: 'Tj',
					strings: isStringToken(operand) ? [operand.value] : [],
					font: currentFont
				});
				break;
			}
			case 'TJ': {
				// The operand is the array that *precedes* the operator, so the
				// token immediately before `TJ` is the closing bracket. Matching
				// backwards is the only way to find its opening bracket without
				// carrying state across operators.
				const open = arrayOperandIndex(tokens, i);
				const strings = open === -1 ? [] : collectArrayStrings(tokens, open);
				ops.push({ op: 'TJ', strings, font: currentFont });
				break;
			}
			case "'": {
				const operand = tokens[i - 1];
				ops.push({
					op: "'",
					strings: isStringToken(operand) ? [operand.value] : [],
					font: currentFont
				});
				break;
			}
			case '"': {
				// Operand order is: aw ac string. The two leading numbers are
				// spacing, not text.
				const operand = tokens[i - 1];
				ops.push({
					op: '"',
					strings: isStringToken(operand) ? [operand.value] : [],
					font: currentFont
				});
				break;
			}
		}
	}

	return ops;
}

/**
 * Index of the `[` whose array is the operand of the operator at `opIdx`.
 *
 * Scans backwards balancing brackets, so nested arrays are stepped over rather
 * than mistaken for the operand. Returns -1 when no array precedes it.
 */
function arrayOperandIndex(tokens, opIdx) {
	let depth = 0;
	for (let i = opIdx - 1; i >= 0; i--) {
		const kind = tokens[i].kind;
		// Scanning backwards, a `]` is met before its own `[`. Each nested `]`
		// raises the level, and the `[` that brings it back to 1 is the one
		// that opens the array the operator actually consumes.
		if (kind === 'array-close') depth++;
		else if (kind === 'array-open') {
			if (depth === 1) return i;
			if (depth > 0) depth--;
		}
		// Dictionary and string tokens cannot contain an unbalanced bracket,
		// because the tokenizer already consumed them whole.
	}
	return -1;
}

/** True for a token that carries decoded string bytes. */
const isStringToken = (t) => !!t && (t.kind === 'string' || t.kind === 'hex');

/** String elements of the `[...]` starting at `open`, ignoring numbers. */
function collectArrayStrings(tokens, open) {
	const out = [];
	let depth = 0;
	for (let i = open; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.kind === 'array-open') {
			depth++;
			continue;
		}
		if (t.kind === 'array-close') {
			depth--;
			if (depth === 0) return out;
			continue;
		}
		if (depth === 1 && isStringToken(t)) out.push(t.value);
	}
	return out;
}

/** Concatenation of every string in `ops`, in order. */
export function concatText(ops) {
	let total = 0;
	for (const op of ops) for (const s of op.strings) total += s.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const op of ops) for (const s of op.strings) {
		out.set(s, at);
		at += s.length;
	}
	return out;
}

/* ── document plumbing ─────────────────────────────────────────────────────── */

/**
 * Raw payload of one stream object.
 *
 * Reads from the object's own dictionary rather than searching for `stream`
 * globally, so an object can never pick up a neighbour's bytes. A declared
 * /Length is trusted only when an `endstream` really follows it at that
 * offset, otherwise the bytes up to the next `endstream` are used.
 *
 * Returns null when the object has no stream at all.
 */
/** @param {{dictEnd: number, dict: string}} obj */
export function streamPayload(text, obj) {
	const streamIdx = text.indexOf('stream', obj.dictEnd);
	if (streamIdx === -1) return null;

	// Guard against matching the tail of a key like `/Endstream`.
	const between = text.slice(obj.dictEnd, streamIdx);
	if (/[A-Za-z0-9]/.test(between.trim().slice(-1) || '')) return null;

	let dataStart = streamIdx + 'stream'.length;
	if (text[dataStart] === '\r') dataStart++;
	if (text[dataStart] === '\n') dataStart++;

	const declared = /\/Length\s+(\d+)/.exec(obj.dict);
	let length = -1;

	if (declared) {
		const n = parseInt(declared[1], 10);
		const after = text.indexOf('endstream', dataStart + n);
		const gap = after === -1 ? '' : text.slice(dataStart + n, after);
		// Up to two whitespace characters may sit between payload and endstream.
		if (after !== -1 && gap.length <= 2 && n >= 0) length = n;
	}
	if (length === -1) {
		const after = text.indexOf('endstream', dataStart);
		length = after === -1 ? Math.max(0, text.length - dataStart) : after - dataStart;
	}
	if (dataStart + length > text.length) return null;

	const filters = [...obj.dict.matchAll(/\/([A-Za-z0-9]+)(?=\s*[\/\[\]R\n\r])/g)]
		.map((m) => m[1])
		.filter((f) => f === 'FlateDecode' || f === 'ASCIIHexDecode' || f === 'ASCII85Decode' || f === 'LZWDecode' || f === 'RunLengthDecode');

	return { bytes: latin1ToBytes(text.slice(dataStart, dataStart + length)), filters };
}

/**
 * Extract the text signature of a flattened PDF.
 *
 * `text` must already have been through `--object-streams=disable`, matching
 * readStructure's contract. `inflate` is injected so this module has no
 * dependency of its own and behaves identically in Node and a worker.
 */
export async function extractTextSignature(text, inflate) {
	const summary = readStructure(text);
	const objects = parseObjects(text);

	const signature = {
		readable: summary.readable,
		pageCount: summary.pageCount,
		pages: [],
		unsupportedPages: []
	};

	for (const page of summary.pages) {
		let reason = null;
		const chunks = [];

		for (const ref of page.contentsRefs) {
			const obj = objects.get(ref);
			if (!obj) {
				reason = `content stream object ${ref} is referenced but not present`;
				break;
			}
			const payload = streamPayload(text, obj);
			if (!payload) {
				reason = `object ${ref} has no readable stream payload`;
				break;
			}

			let bytes = payload.bytes;
			// Only FlateDecode is decoded here. Anything else is reported rather
			// than guessed at, because scanning still-encoded bytes for `Tj`
			// would manufacture operators that are not there.
			const unknown = payload.filters.filter((f) => f !== 'FlateDecode');
			if (unknown.length) {
				reason = `content stream ${ref} uses unsupported filter(s): ${unknown.join(', ')}`;
				break;
			}
			if (payload.filters.includes('FlateDecode')) {
				try {
					bytes = await inflate(bytes);
				} catch (err) {
					reason = `content stream ${ref} failed to inflate: ${err instanceof Error ? err.message : String(err)}`;
					break;
				}
			}
			chunks.push(bytesToLatin1(bytes));
		}

		if (reason) {
			signature.unsupportedPages.push({ page: page.index, reason });
			signature.pages.push({ page: page.index, ops: [], text: new Uint8Array(0), unsupported: reason });
			continue;
		}

		const ops = extractTextOps(chunks.join(''));
		signature.pages.push({ page: page.index, ops, text: concatText(ops), unsupported: null });
	}

	return signature;
}

export { rawValue };