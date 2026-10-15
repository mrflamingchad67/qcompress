/**
 * Text-layer extractor and comparator: unit tests and negative controls.
 *
 * No PDF, no browser, no engine. This proves the tokenizer, the string
 * decoder, the signature builder and the comparison rule behave correctly at
 * known boundaries - including at boundaries that MUST fail.
 *
 * A passing fixture corpus (test-text-integrity.mjs) only shows no regression
 * was observed. It cannot distinguish a correct extractor from one broken to
 * return nothing. Every rule here is therefore also exercised with an input
 * that must be detected.
 *
 * The inline-image cases matter more than they look: nine corpus fixtures
 * contain `)` followed by `"` purely by accident inside JPEG payloads. A regex
 * extractor would report those as text-showing operators and invent text that
 * is not in the document.
 *
 * Usage: bun run test:text-extract
 */
import { tokenize, extractTextOps, concatText, readLiteralString, readHexString } from '../lib/textlayer.mjs';
import { comparePage, compareText, preview } from '../lib/textcompare.mjs';

let passed = 0;
let failed = 0;
const failures = [];
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

function test(name, fn) {
	try {
		fn();
		passed++;
	} catch (err) {
		failed++;
		failures.push(`${name}: ${err.message}`);
		report(`  FAIL  ${name}`);
		report(`        ${err.message}`);
	}
}

function assert(cond, what) {
	if (!cond) throw new Error(what);
}

const enc = (s) => new TextEncoder().encode(s);
const str = (u8) => new TextDecoder('latin1').decode(u8);

/** The single concatenated text payload of a stream. */
const textOf = (stream) => str(concatText(extractTextOps(stream)));

/** One signature page from a raw stream, for comparator tests. */
const page = (ops, unsupported = null) => {
	const list = typeof ops === 'string' ? extractTextOps(ops) : ops;
	return { page: 1, ops: list, text: concatText(list), unsupported };
};

const doc = (pages) => ({ readable: true, pageCount: pages.length, pages, unsupportedPages: [] });

/* ── A. tokenizer: syntax that must be handled ─────────────────────────────── */

test('A1  a plain Tj string is extracted', () => {
	assert(textOf('BT /F1 12 Tf (Hello) Tj ET') === 'Hello', textOf('BT /F1 12 Tf (Hello) Tj ET'));
});

test('A2  a TJ array yields its strings in order', () => {
	const tokens = tokenize('[(A) (B) (C)] TJ');
	const ops = extractTextOps('[(A) (B) (C)] TJ');
	assert(ops.length === 1 && ops[0].op === 'TJ', JSON.stringify(ops.map((o) => o.op)));
	assert(
		ops[0].strings.length === 3,
		`${ops[0].strings.length} segments; tokens=${JSON.stringify(tokens.map((t) => [t.kind, typeof t.value === 'string' ? t.value : `<${t.value.length}B>`]))}`
	);
	assert(ops[0].strings.map(str).join('|') === 'A|B|C', ops[0].strings.map(str).join('|'));
});

test('A3  a TJ array interleaved with numbers keeps only the strings', () => {
	// Numeric values position glyphs; they are not text and must not appear.
	const ops = extractTextOps('[(A) -250 (B) 500 (C)] TJ');
	assert(ops[0].strings.length === 3, `${ops[0].strings.length} segments`);
	assert(ops[0].strings.map(str).join('|') === 'A|B|C', ops[0].strings.map(str).join('|'));
	assert(!ops[0].strings.some((s) => s.length === 3 && str(s) === '-250'), 'a number leaked in as text');
});

test("A4  the ' operator's string is extracted", () => {
	const ops = extractTextOps("BT (Line one) ' (Line two) ' ET");
	assert(ops.length === 2, `${ops.length} ops`);
	assert(ops.every((o) => o.op === "'"), 'wrong operator kind');
	assert(ops.map((o) => str(o.strings[0])).join('|') === 'Line one|Line two', ops.map((o) => str(o.strings[0])).join('|'));
});

test('A5  the " operator takes its third operand, not its spacing numbers', () => {
	const ops = extractTextOps('BT 1.5 2.5 (Word) " ET');
	assert(ops.length === 1 && ops[0].op === '"', JSON.stringify(ops));
	assert(ops[0].strings.length === 1, `${ops[0].strings.length} strings`);
	assert(str(ops[0].strings[0]) === 'Word', str(ops[0].strings[0]));
});

test('A6  escaped parentheses stay inside the string', () => {
	assert(textOf('(a \\(b\\) c) Tj') === 'a (b) c', textOf('(a \\(b\\) c) Tj'));
});

test('A7  an escaped backslash is one backslash, not two', () => {
	assert(textOf('(back\\\\slash) Tj') === 'back\\slash', textOf('(back\\\\slash) Tj'));
});

test('A8  octal escapes decode to bytes', () => {
	const ops = extractTextOps('(\\101\\102\\103) Tj');
	assert(str(ops[0].strings[0]) === 'ABC', str(ops[0].strings[0]));
});

test('A9  a backslash-newline continuation contributes nothing', () => {
	// The line ending is consumed by the escape, so "ab" must not gain a break.
	assert(textOf('(ab\\\ncd) Tj') === 'abcd', JSON.stringify(textOf('(ab\\\ncd) Tj')));
});

test('A10 a hex string decodes to the same bytes as its literal form', () => {
	const hex = extractTextOps('<48656C6C6F> Tj');
	assert(str(hex[0].strings[0]) === 'Hello', str(hex[0].strings[0]));
});

test('A11 a literal and a hex string with the same bytes are indistinguishable', () => {
	// Both spellings must produce identical payloads, so a candidate that
	// re-spells a string is not reported as changed text.
	assert(textOf('(Hi) Tj') === textOf('<4869> Tj'), `${textOf('(Hi) Tj')} vs ${textOf('<4869> Tj')}`);
});

test('A12 an empty string is an empty operand, not a missing one', () => {
	const ops = extractTextOps('() Tj');
	assert(ops.length === 1, `${ops.length} ops`);
	assert(ops[0].strings.length === 1, 'the empty string operand was dropped');
	assert(ops[0].strings[0].length === 0, `${ops[0].strings[0].length} bytes`);
});

test('A13 several text operators on one line are all found, in order', () => {
	const ops = extractTextOps('BT (one) Tj (two) Tj (three) Tj ET');
	assert(ops.length === 3, `${ops.length} ops`);
	assert(ops.map((o) => str(o.strings[0])).join('|') === 'one|two|three', ops.map((o) => str(o.strings[0])).join('|'));
});

test('A14 comments and newlines between operators do not hide them', () => {
	const stream = 'BT\n% this comment mentions Tj and TJ\n(one) Tj\n% another\n(two) Tj\nET';
	assert(textOf(stream) === 'onetwo', JSON.stringify(textOf(stream)));
});

test('A15  bytes that look like an operator inside a string are not operators', () => {
	// The string's payload contains "Tj" and "TJ" verbatim. Only the real
	// operators outside the string may be extracted.
	const ops = extractTextOps('(literal Tj and TJ inside) Tj');
	assert(ops.length === 1, `${ops.length} ops - the in-string text was mistaken for operators`);
	assert(str(ops[0].strings[0]) === 'literal Tj and TJ inside', str(ops[0].strings[0]));
});

test('A16  a comment naming an operator extracts nothing', () => {
	const ops = extractTextOps('% (ghost) Tj\n% TJ\nBT (real) Tj ET');
	assert(ops.length === 1, `${ops.length} ops - a comment produced text`);
	assert(str(ops[0].strings[0]) === 'real', str(ops[0].strings[0]));
});

test('A17  text-like bytes in non-text operands are not extracted', () => {
	// A name, a number and a boolean-ish token, none of which show text.
	const ops = extractTextOps('BT /TjName 12 Tf /True (only this) Tj ET');
	assert(ops.length === 1, `${ops.length} ops`);
	assert(str(ops[0].strings[0]) === 'only this', str(ops[0].strings[0]));
});

test('A18  a word that merely starts with an operator is not that operator', () => {
	const ops = extractTextOps('TjSomething (real) Tj');
	assert(ops.length === 1, `${ops.length} ops - TjSomething was treated as Tj`);
});

test('A19  a nested array inside TJ does not leak its strings into the segments', () => {
	// Real TJ arrays are flat. A malformed one must not have a deeper array's
	// contents treated as top-level text segments, so only the direct children
	// are collected.
	const ops = extractTextOps('[(A) [(nested)] (B)] TJ');
	assert(ops[0].strings.map(str).join('|') === 'A|B', ops[0].strings.map(str).join('|'));
});

test('A20  inline image payload is skipped, not scanned for operators', () => {
	// The payload below contains ") Tj" and ") \"" sequences. A regex would
	// report them; a correct tokenizer must not touch them at all.
	const stream =
		'q\nBI /W 2 /H 2 /CS /G /BPC 8 ID \u0001\u0002) Tj \u0003\u0004) " \u0005\u0006 EI\nQ\nBT (real) Tj ET';
	const ops = extractTextOps(stream);
	assert(ops.length === 1, `${ops.length} ops - inline image payload was scanned`);
	assert(str(ops[0].strings[0]) === 'real', str(ops[0].strings[0]));
});

test('A21  balanced nested parentheses inside a string are preserved', () => {
	assert(textOf('(outer (inner) tail) Tj') === 'outer (inner) tail', textOf('(outer (inner) tail) Tj'));
});

test('A22  a hex string may contain whitespace and odd digit counts', () => {
	const ops = extractTextOps('<48 65 6C 6C 6F> Tj');
	assert(str(ops[0].strings[0]) === 'Hello', JSON.stringify(str(ops[0].strings[0])));
	const odd = extractTextOps('<486> Tj');
	assert(odd[0].strings[0].length === 2, `${odd[0].strings[0].length} bytes for an odd-length hex string`);
	assert(odd[0].strings[0][1] === 0x60, `odd trailing nibble: 0x${odd[0].strings[0][1].toString(16)}`);
});

test('A23  a dictionary operand does not disturb operator detection', () => {
	const ops = extractTextOps('BT /Span << /ActualText (x) >> BDC (real) Tj EMC ET');
	assert(ops.length === 1, `${ops.length} ops`);
	assert(str(ops[0].strings[0]) === 'real', str(ops[0].strings[0]));
});

test('A24  a Tj with a non-string operand yields an empty operation, not a crash', () => {
	const ops = extractTextOps('BT /Foo Tj ET');
	assert(ops.length === 1, `${ops.length} ops`);
	assert(ops[0].strings.length === 0, `${ops[0].strings.length} strings`);
});

test('A25  an unterminated string does not fabricate operators out of its own body', () => {
	// With no closing paren the "Tj" really is string content, so the correct
	// answer is zero operators - not a phantom Tj reading the string as text.
	// What must not happen is a hang or a fabricated pass.
	const ops = extractTextOps('(unterminated Tj');
	assert(ops.length === 0, `${ops.length} ops - an unterminated string produced an operator`);
});

test('A26  readLiteralString and readHexString agree with the tokenizer', () => {
	assert(str(readLiteralString('(abc) rest', 0).bytes) === 'abc', 'literal reader');
	assert(str(readHexString('<616263> rest', 0).bytes) === 'abc', 'hex reader');
});

test('A27  tokenizer never emits an operator for delimiter characters', () => {
	const kinds = tokenize('( ) [ ] << >> /Name 1 2.5 op').map((t) => t.kind);
	assert(kinds.includes('array-open') && kinds.includes('dict-close'), JSON.stringify(kinds));
	assert(!kinds.includes('operator') || kinds.filter((k) => k === 'operator').length === 1, JSON.stringify(kinds));
});

/* ── B. comparator: what must pass and what must fail ──────────────────────── */

test('B1  identical signatures pass', () => {
	const a = doc([page('BT (Hello) Tj ET')]);
	const b = doc([page('BT (Hello) Tj ET')]);
	const r = compareText(a, b);
	assert(r.ok, JSON.stringify(r.problems));
});

test('B2  a single changed byte fails', () => {
	const a = doc([page('(Hello) Tj')]);
	const b = doc([page('(Hallo) Tj')]);
	const r = compareText(a, b);
	assert(!r.ok, 'a one-character change was ACCEPTED');
	assert(r.problems.some((p) => p.kind === 'text-bytes'), JSON.stringify(r.problems.map((p) => p.kind)));
});

test('B3  a removed string fails', () => {
	const a = doc([page('[(A) (B)] TJ')]);
	const b = doc([page('[(A)] TJ')]);
	const r = compareText(a, b);
	assert(!r.ok, 'a removed TJ segment was ACCEPTED');
	assert(r.problems.some((p) => p.kind === 'segment-count'), JSON.stringify(r.problems.map((p) => p.kind)));
});

test('B4  a shortened string fails', () => {
	const a = doc([page('(Hello world) Tj')]);
	const b = doc([page('(Hello) Tj')]);
	const r = compareText(a, b);
	assert(!r.ok, 'a shortened string was ACCEPTED');
	assert(r.problems.some((p) => p.kind === 'text-bytes' && p.kind === p.kind), 'no text-bytes problem');
});

test('B5  an additional string fails', () => {
	const a = doc([page('(A) Tj')]);
	const b = doc([page('(A) Tj (B) Tj')]);
	const r = compareText(a, b);
	assert(!r.ok, 'extra text was ACCEPTED');
	assert(r.problems.some((p) => p.kind === 'op-count'), JSON.stringify(r.problems.map((p) => p.kind)));
});

test('B6  reordered text fails', () => {
	const a = doc([page('(first) Tj (second) Tj')]);
	const b = doc([page('(second) Tj (first) Tj')]);
	const r = compareText(a, b);
	assert(!r.ok, 'reordered text was ACCEPTED');
});

test('B7  a page with no text on both sides passes', () => {
	// An image-only or genuinely blank page is legitimate. Preservation is the
	// requirement, not the presence of text.
	const a = doc([page('q 1 0 0 1 0 0 cm /Im0 Do Q')]);
	const b = doc([page('q 1 0 0 1 0 0 cm /Im0 Do Q')]);
	const r = compareText(a, b);
	assert(r.ok, JSON.stringify(r.problems));
});

test('B8  a page that HAD text and now has none fails', () => {
	const a = doc([page('(important) Tj')]);
	const b = doc([page('q 1 0 0 1 0 0 cm /Im0 Do Q')]);
	const r = compareText(a, b);
	assert(!r.ok, 'silently emptied text page was ACCEPTED');
});

test('B9  an empty candidate does not pass merely because the extractor returned nothing', () => {
	// The failure mode this guards: a broken extractor yields [] on both sides
	// and the comparison trivially passes. Making the original non-empty means
	// that cannot happen here.
	const a = doc([page('(x) Tj')]);
	const b = doc([page('')]);
	const r = compareText(a, b);
	assert(!r.ok, 'an empty candidate passed against non-empty text');
});

test('B10 a different page count fails independently of text', () => {
	const a = doc([page('(one) Tj'), page('(two) Tj')]);
	const b = doc([page('(one) Tj')]);
	const r = compareText(a, b);
	assert(!r.ok, 'a dropped page was ACCEPTED');
	assert(r.problems.some((p) => p.kind === 'page-count'), JSON.stringify(r.problems.map((p) => p.kind)));
});

test('B11 an extra page fails', () => {
	const a = doc([page('(one) Tj')]);
	const b = doc([page('(one) Tj'), page('(two) Tj')]);
	const r = compareText(a, b);
	assert(!r.ok, 'an added page was ACCEPTED');
	assert(r.problems.some((p) => p.kind === 'page-count'), JSON.stringify(r.problems.map((p) => p.kind)));
});

test('B12 pages are not merged into one aggregate signature', () => {
	// Two pages, each with text. Moving page 2's text onto page 1 and leaving
	// page 2 empty must be caught, which an aggregate would miss.
	const a = doc([page('(one) Tj'), page('(two) Tj')]);
	const b = doc([page('(one) Tj (two) Tj'), page('')]);
	const r = compareText(a, b);
	assert(!r.ok, 'a page-boundary change was ACCEPTED');
	assert(r.problems.some((p) => p.page === 2), `no failure attributed to page 2: ${JSON.stringify(r.problems)}`);
});

test('B13 a candidate whose stream could not be read fails, and says why', () => {
	const a = doc([page('(x) Tj')]);
	const b = doc([{ page: 1, ops: [], text: new Uint8Array(0), unsupported: 'inflate failed' }]);
	const r = compareText(a, b);
	assert(!r.ok, 'an unreadable candidate stream was ACCEPTED');
	assert(r.problems.some((p) => p.kind === 'unreadable-candidate'), JSON.stringify(r.problems.map((p) => p.kind)));
});

test('B14 both sides unreadable is not a pass', () => {
	const a = doc([{ page: 1, ops: [], text: new Uint8Array(0), unsupported: 'x' }]);
	const b = doc([{ page: 1, ops: [], text: new Uint8Array(0), unsupported: 'x' }]);
	const r = compareText(a, b);
	assert(!r.ok, 'two unreadable pages were reported as a match');
});

test('B15 the diagnostic names the page and the first difference', () => {
	const a = doc([page('(alpha) Tj'), page('(beta) Tj')]);
	const b = doc([page('(alpha) Tj'), page('(bxta) Tj')]);
	const r = compareText(a, b);
	assert(!r.ok, 'expected a failure');
	const p = r.problems.find((x) => x.kind === 'text-bytes');
	assert(p, `no text-bytes problem: ${JSON.stringify(r.problems.map((x) => x.kind))}`);
	assert(p.page === 2, `problem attributed to page ${p.page}, expected 2`);
	assert(/byte 1/.test(p.detail), `unhelpful detail: ${p.detail}`);
});

test('B16 a different operator with the same bytes is still reported', () => {
	// Rule 2 of the equality rule: same bytes, different segmentation. QCompress
	// does not re-segment content streams, so this is a genuine finding rather
	// than a cosmetic one, and the rule was fixed before the corpus was run.
	const a = doc([page([{ op: 'Tj', strings: [enc('AB')] }])]);
	const b = doc([page([{ op: 'Tj', strings: [enc('A')] }, { op: 'Tj', strings: [enc('B')] }])]);
	const r = compareText(a, b);
	assert(!r.ok, 're-segmented text was ACCEPTED');
	assert(r.problems.some((p) => p.kind === 'op-count'), JSON.stringify(r.problems.map((p) => p.kind)));
});

test('B17 preview is bounded and never emits raw control bytes', () => {
	const p = preview(enc('ok'), 60);
	assert(p === 'ok', p);
	const control = preview(Uint8Array.from([0x00, 0x0a, 0x41]));
	assert(!/[\n\r]/.test(control), `control characters leaked: ${JSON.stringify(control)}`);
	const long = preview(enc('x'.repeat(500)), 10);
	assert(long.includes('(+490B)'), `truncation not reported: ${long}`);
});

test('B18 concatText concatenates in operator order', () => {
	const ops = [
		{ op: 'Tj', strings: [enc('one')] },
		{ op: 'TJ', strings: [enc('two'), enc('three')] }
	];
	assert(str(concatText(ops)) === 'onetwothree', str(concatText(ops)));
});

test('B19 comparePage rejects a size-mismatched segment', () => {
	const a = page('[(abc)] TJ');
	const b = page([{ op: 'TJ', strings: [enc('abcd')] }]);
	const r = comparePage(a, b);
	assert(!r.ok, 'a length change inside one segment was ACCEPTED');
});

test('B20 an original with no text and a candidate WITH text fails', () => {
	const a = doc([page('q 1 0 0 1 0 0 cm /Im0 Do Q')]);
	const b = doc([page('(injected) Tj')]);
	const r = compareText(a, b);
	assert(!r.ok, 'text appearing where the original had none was ACCEPTED');
});

/* ── report ────────────────────────────────────────────────────────────────── */

report('');
report('Text-layer extractor and comparator');
report(`${passed} passed, ${failed} failed`);
if (failures.length) {
	report('\nFailures:');
	for (const f of failures) report(`  - ${f}`);
}
report('');
process.exit(failed ? 1 : 0);