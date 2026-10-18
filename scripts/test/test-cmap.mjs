/**
 * Unit tests for the /ToUnicode CMap parser.
 *
 * A parser that silently drops mappings is worse than no parser: extracted text
 * would still compare equal to itself and every suite would stay green. So the
 * cases below are chosen for the ways this parser can be WRONG, not merely
 * incomplete.
 *
 * Run: bun scripts/test/test-cmap.mjs
 */
import { parseCMap, splitIntoCodes, utf16beToString, toUnicodeMap, fingerprint } from '../lib/cmap.mjs';

const report = (...a) => process.stdout.write(a.join(' ') + '\n');

let passed = 0;
let failed = 0;
const failures = [];

function eq(actual, expected, what) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		passed++;
		report(`  ok    ${what}`);
	} else {
		failed++;
		failures.push(`${what}: expected ${e}, got ${a}`);
		report(`  FAIL  ${what}\n          expected ${e}\n          got      ${a}`);
	}
}

report('');
report('CMap parser');

/* ── bfchar ────────────────────────────────────────────────────────────────── */

{
	const c = parseCMap(`/CIDInit /ProcSet findresource begin
12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar
<0003> <0020>
<0024> <0041>
endbfchar
endcmap`);
	eq(c.toUnicode.get('0003'), '0020', 'bfchar maps 0003 to U+0020');
	eq(c.toUnicode.get('0024'), '0041', 'bfchar maps 0024 to U+0041');
	eq(c.codeSpaces, [{ lo: 0, hi: 65535, bytes: 2 }], 'codespacerange declares 2-byte codes');
	eq(c.bfcharCount, 2, 'two bfchar entries counted');
}

{
	// Whitespace and newlines are legal anywhere between tokens.
	const c = parseCMap(`
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
3 beginbfchar
<0001>
  <0041>
<0002>   <0042>
endbfchar`);
	eq(c.toUnicode.get('0001'), '0041', 'bfchar tolerates newlines between tokens');
	eq(c.toUnicode.get('0002'), '0042', 'bfchar tolerates runs of spaces');
}

/* ── bfrange, scalar form ──────────────────────────────────────────────────── */

{
	const c = parseCMap(`
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 beginbfrange
<0020> <0024> <0061>
endbfrange`);
	eq(c.toUnicode.get('0020'), '0061', 'bfrange scalar: first code takes the stated destination');
	eq(c.toUnicode.get('0021'), '0062', 'bfrange scalar: the destination increments');
	eq(c.toUnicode.get('0024'), '0065', 'bfrange scalar: last code is the fifth increment');
	eq(c.toUnicode.size, 5, 'bfrange scalar expands to five mappings');
	eq(c.bfrangeCount, 5, 'bfrange scalar counted per expanded code');
}

/* An increment that overflows the destination width wraps within it, rather
 * than growing a character the CMap never contained. */
{
	const c = parseCMap(`
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 beginbfrange
<0001> <0003> <00FE>
endbfrange`);
	eq(c.toUnicode.get('0001'), '00FE', 'range starting at the last code');
	eq(c.toUnicode.get('0003'), '0100', 'an increment past the width wraps rather than growing');
}

/* ── bfrange, array form ───────────────────────────────────────────────────── */

{
	const c = parseCMap(`
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 beginbfrange
<0025> <0027> [<0068> <0069> <006A>]
endbfrange`);
	eq(c.toUnicode.get('0025'), '0068', 'bfrange array: first target');
	eq(c.toUnicode.get('0026'), '0069', 'bfrange array: second target');
	eq(c.toUnicode.get('0027'), '006A', 'bfrange array: third target');
}

/* The trap: a scalar regex also matches the head of an array range, so a
 * careless parser keeps only the first array target. If both forms appear in
 * one block, both must survive. */
{
	const c = parseCMap(`
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 beginbfrange
<0010> <0011> [<0070> <0071>]
<0020> <0021> <0080>
endbfrange`);
	eq(c.toUnicode.get('0010'), '0070', 'array form first target survives alongside a scalar range');
	eq(c.toUnicode.get('0011'), '0071', 'array form second target survives');
	eq(c.toUnicode.get('0020'), '0080', 'scalar range survives alongside an array range');
	eq(c.toUnicode.get('0021'), '0081', 'scalar range second code takes the incremented destination');
	eq(c.toUnicode.size, 4, 'both forms contribute all four mappings');
}

/* ── malformed and adversarial input ────────────────────────────────────────── */

{
	// A range wider than its target array must not be expanded past the array.
	const c = parseCMap(`
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 beginbfrange
<0001> <00FF> [<0041> <0042>]
endbfrange`);
	eq(c.toUnicode.size, 2, 'a range wider than its target array is capped, not expanded');
}

{
	// An absurd range must terminate quickly rather than looping to a huge bound.
	const started = Date.now();
	const c = parseCMap(`
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 beginbfrange
<0000> <FFFF> <0041>
endbfrange`);
	const ms = Date.now() - started;
	eq(c.toUnicode.size <= 65536, true, 'a maximal range is bounded');
	eq(ms < 2000, true, `a maximal range parses quickly (${ms} ms)`);
}

{
	const c = parseCMap('');
	eq(c.toUnicode.size, 0, 'an empty CMap yields no mappings');
	eq(c.codeSpaces.length, 0, 'an empty CMap declares no code spaces');
}

{
	const c = parseCMap('not a cmap at all');
	eq(c.toUnicode.size, 0, 'garbage yields no mappings rather than throwing');
}

/* ── one-byte fonts ────────────────────────────────────────────────────────── */

{
	const c = parseCMap(`
1 begincodespacerange <00> <FF> endcodespacerange
1 beginbfchar
<41> <0041>
<42> <0042>
endbfchar`);
	eq(c.codeSpaces, [{ lo: 0, hi: 255, bytes: 1 }], 'one-byte code space is read as 1 byte');
	eq(c.toUnicode.get('41'), '0041', 'one-byte source code maps correctly');
}

/* ── mixed code space lengths ──────────────────────────────────────────────── */

{
	const c = parseCMap(`
2 begincodespacerange
<00> <7F>
<8140> <9FFC>
endcodespacerange
1 beginbfchar
<41> <0041>
<8140> <3042>
endbfchar`);
	eq(c.codeSpaces.length, 2, 'two code space ranges are read');
	eq(c.toUnicode.get('41'), '0041', 'single-byte mapping present in a mixed font');
	eq(c.toUnicode.get('8140'), '3042', 'double-byte mapping present in a mixed font');

	const codes = splitIntoCodes(Buffer.from([0x41, 0x81, 0x40]), c);
	eq(codes, ['41', '8140'], 'a mixed-width string splits on the declared byte lengths');
}

{
	const c = parseCMap(`
1 begincodespacerange <0000> <FFFF> endcodespacerange`);
	eq(splitIntoCodes(Buffer.from([0x00, 0x48]), c), ['0048'], 'two-byte codes split correctly');
	eq(splitIntoCodes(Buffer.from([0x00, 0x48, 0x00, 0x65]), c), ['0048', '0065'], 'consecutive codes split');
	// With no code space declared, guessing would produce wrong text quietly.
	eq(splitIntoCodes(Buffer.from([0x00, 0x48]), { codeSpaces: [] }), null, 'no code space returns null rather than guessing');
}

/* ── UTF-16BE targets ──────────────────────────────────────────────────────── */

eq(utf16beToString('0048'), 'H', 'a single BMP character decodes');
eq(utf16beToString('00480065'), 'He', 'two characters decode');
eq(utf16beToString('D83DDE00'), '😀', 'a surrogate pair recombines into one character');
eq(utf16beToString(''), '', 'an empty target decodes to an empty string');
eq(utf16beToString('004'), '', 'a trailing odd byte does not throw');

/* ── comparison helpers ────────────────────────────────────────────────────── */

{
	const a = parseCMap('1 beginbfchar <0001> <0041> <0002> <0042> endbfchar');
	const b = parseCMap('1 beginbfchar <0002> <0042> <0001> <0041> endbfchar');
	eq(fingerprint(a), fingerprint(b), 'a re-serialised CMap with the same mappings fingerprints identically');

	const c = parseCMap('1 beginbfchar <0001> <0041> endbfchar');
	eq(fingerprint(a) === fingerprint(c), false, 'a CMap with fewer mappings fingerprints differently');

	eq([...toUnicodeMap(a).keys()], ['0001', '0002'], 'toUnicodeMap exposes every source code');
	eq(toUnicodeMap(a).get('0001'), 'A', 'toUnicodeMap yields decoded characters');
}

report('');
report(`${passed} passed, ${failed} failed`);
if (failures.length) {
	report('');
	for (const f of failures) report(`  - ${f}`);
}
report('');

process.exit(failed ? 1 : 0);