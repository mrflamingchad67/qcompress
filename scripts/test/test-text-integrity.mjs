/**
 * Text-layer integrity: does compression preserve what the page says?
 *
 * The visual suite proves a page still looks right. This proves the text under
 * those pixels is still there - that every string handed to a text-showing
 * operator survives compression unchanged, in order, on every page.
 *
 * THE INVARIANT
 *
 *   Compression must not remove or alter the ordered string payloads supplied
 *   to a page's text-showing operators.
 *
 * That argument used to live only as a claim in the README ("we never rewrite
 * content streams"). It is now checked. The claim was almost certainly true,
 * but an unverified architectural expectation is the same thing that hid the
 * deduplication bug, where pages rendered blank while every suite passed.
 *
 * WHAT THIS DOES NOT PROVE
 *
 * Extracted bytes are font-encoded, not Unicode. Mapping them to characters
 * needs the font's encoding and its /ToUnicode CMap, neither of which is
 * consulted here. So this suite does NOT prove correct text extraction, correct
 * reading order, tagged-PDF validity, /ToUnicode correctness, or screen-reader
 * accessibility. Two documents with different encodings can render identically
 * and differ here. That is why this suite runs ALONGSIDE the visual one and
 * neither replaces the other.
 *
 * Usage: bun run test:text-integrity [--verbose] [fixture ...]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { optimize } from '../../src/lib/qpdf/pipeline.ts';
import { bytesToLatin1 } from '../../src/lib/qpdf/bytes.ts';
import { makeRunner, makeCodec, makeZip } from '../lib/engine.mjs';
import { FIXTURES } from '../lib/fixture-manifest.mjs';
import { extractTextSignature } from '../lib/textlayer.mjs';
import { compareText, describeTextProblems } from '../lib/textcompare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const only = argv.filter((a) => !a.startsWith('--'));

const runner = makeRunner();
const codec = await makeCodec();
const zip = makeZip();

const FLATTEN = ['--object-streams=disable', '--stream-data=preserve'];

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
	try {
		await fn();
		passed++;
		if (VERBOSE) report(`  pass  ${name}`);
	} catch (err) {
		failed++;
		failures.push(`${name}: ${err.message}`);
		report(`  FAIL  ${name}`);
		report(`        ${err.message.split('\n').join('\n        ')}`);
	}
}

function assert(cond, what) {
	if (!cond) throw new Error(what);
}

/** Flatten for the parser; null when qpdf cannot read the file at all. */
async function flatten(bytes) {
	const r = await runner(bytes, FLATTEN);
	return r.out ? bytesToLatin1(r.out) : null;
}

const load = (n) => readFile(path.join(here, '..', 'fixtures', n)).then((b) => new Uint8Array(b));

/** Both signatures, or a reason they could not be built. */
async function signaturesFor(a, b) {
	const [ta, tb] = [await flatten(a), await flatten(b)];
	if (ta === null || tb === null) return { error: 'qpdf could not flatten the document' };
	const [sa, sb] = [
		await extractTextSignature(ta, zip.inflate),
		await extractTextSignature(tb, zip.inflate)
	];
	return { sa, sb };
}

/* ── 1. the pipeline-level check, every fixture x every mode ──────────────── */

const candidates = Object.entries(FIXTURES)
	.map(([name, spec]) => ({ name, spec }))
	.filter(({ spec }) => spec.valid !== false)
	.filter(({ name }) => only.length === 0 || only.includes(name));

const withText = [];
const withoutText = [];
let pageComparisons = 0;
let unsupportedTotal = 0;

report('');
report('Text-layer integrity');
report('  invariant: compression must not remove or alter the ordered string');
report('             payloads supplied to Tj / TJ / \' / " on any page');
report(`  fixtures  : ${candidates.length}`);

for (const mode of ['lossless', 'balanced', 'maximum']) {
	report(`\n[${mode}]`);

	for (const { name, spec } of candidates) {
		const label = `${mode}: ${name}`;

		await test(label, async () => {
			const bytes = await load(name);
			const out = await optimize({ bytes, mode, zip }, runner, codec);
			const { error, sa, sb } = await signaturesFor(bytes, out.bytes);
			if (error) throw new Error(error);

			// Page count first, and independently: comparing text across a page
			// mismatch would pair pages that do not correspond.
			assert(
				sa.pageCount === sb.pageCount,
				`page count changed: ${sa.pageCount} -> ${sb.pageCount}`
			);

			const r = compareText(sa, sb);
			pageComparisons += r.pages.length;

			// A page whose content could not be decoded is an UNKNOWN page, not
			// an empty one. It is counted and reported rather than passed.
			const unreadable = [
				...sa.unsupportedPages.map((u) => `original p${u.page}: ${u.reason}`),
				...sb.unsupportedPages.map((u) => `candidate p${u.page}: ${u.reason}`)
			];
			if (unreadable.length) {
				unsupportedTotal += unreadable.length;
				throw new Error(`content stream could not be read - coverage gap, not a pass:\n  ${unreadable.join('\n  ')}`);
			}

			assert(r.ok, `text changed :: ${describeTextProblems(r.problems)}`);

			const ops = r.pages.reduce((n, p) => n + p.ops, 0);
			const bytesOfText = r.pages.reduce((n, p) => n + p.bytes, 0);
			if (bytesOfText > 0) withText.push(`${name}/${mode}: ${ops} op(s), ${bytesOfText}B`);
			else withoutText.push(`${name}/${mode}`);

			if (VERBOSE) report(`  pass  ${label} - ${ops} text op(s), ${bytesOfText}B`);
		});
	}
}

/* ── 2. negative control on a REAL corrupted PDF ──────────────────────────── */

/*
 * The unit tests prove the comparator reacts to changed arrays. They do not
 * prove the full path - real fixture bytes, real qpdf flattening, real inflate,
 * real page walk - reacts to them. This does, by deterministically corrupting
 * a genuine PDF and running it through exactly the same code as section 1.
 *
 * text-1page.pdf's content stream is uncompressed and short:
 *     BT /F1 12 Tf 20 100 Td (Hello) Tj ET
 * so the corruption is a literal substitution with /Length corrected, and no
 * dependency is involved.
 */
report('');
report('[negative control] a genuinely corrupted PDF is rejected');

/**
 * Replace bytes inside a PDF's uncompressed content stream.
 *
 * The replacement MUST be the same length as what it replaces. Shortening a
 * stream shifts every byte offset after it and invalidates the cross-reference
 * table, so qpdf would refuse the file and the control would be testing qpdf's
 * error handling rather than the text comparison. Same-length edits keep the
 * document valid, which is what makes this a meaningful control: the file is a
 * well-formed PDF that simply no longer shows its text.
 */
function corruptStream(pdfBytes, find, replace) {
	const text = bytesToLatin1(pdfBytes);
	const at = text.indexOf(find);
	assert(at !== -1, `could not find ${JSON.stringify(find)} to corrupt`);
	assert(
		find.length === replace.length,
		'the corruption must preserve stream length, or the xref table breaks and the control proves nothing'
	);

	const corrupted = text.slice(0, at) + replace + text.slice(at + find.length);
	assert(corrupted !== text, `corrupting ${JSON.stringify(find)} changed nothing`);
	return new Uint8Array(Buffer.from(corrupted, 'latin1'));
}

await test('CONTROL: removing the Tj operator from a real fixture is detected', async () => {
	const bytes = await load('text-1page.pdf');

	// "20 100 Td (Hello) Tj ET"  ->  "20 100 Td (Hello)   ET "
	// The Tj operator is gone - its two characters become whitespace - and one
	// space is added so the byte count is unchanged. The file stays a valid PDF
	// that simply no longer shows its text: precisely the silent damage the
	// structural suite cannot see and this suite exists to catch.
	const corrupted = corruptStream(bytes, '20 100 Td (Hello) Tj ET', '20 100 Td (Hello)   ET ');

	// The corrupted copy must still be a document qpdf can read, or the control
	// would only be proving that qpdf rejects malformed files.
	const chk = await runner(corrupted, ['--check']);
	assert(chk.code === 0, `the corrupted PDF is not structurally valid (qpdf exit ${chk.code}) - the control would prove nothing`);

	const originalSig = await extractTextSignature(await flatten(bytes), zip.inflate);
	const corruptSig = await extractTextSignature(await flatten(corrupted), zip.inflate);
	assert(originalSig.pages[0].text.length === 5, `fixture should read "Hello" (${originalSig.pages[0].text.length}B)`);
	assert(corruptSig.pages[0].text.length === 0, `corrupted copy should have no text (${corruptSig.pages[0].text.length}B)`);

	const r = compareText(originalSig, corruptSig);
	assert(!r.ok, 'a real corrupted PDF was ACCEPTED - the check cannot fail');
	assert(
		r.problems.some((p) => p.kind === 'text-bytes' || p.kind === 'op-count'),
		`expected a text-bytes or op-count problem, got ${JSON.stringify(r.problems.map((p) => p.kind))}`
	);
});

await test('CONTROL: altering a string inside a real fixture is detected', async () => {
	const bytes = await load('text-1page.pdf');
	const corrupted = corruptStream(bytes, '(Hello) Tj', '(Hallo) Tj');

	const originalSig = await extractTextSignature(await flatten(bytes), zip.inflate);
	const corruptSig = await extractTextSignature(await flatten(corrupted), zip.inflate);
	const r = compareText(originalSig, corruptSig);
	assert(!r.ok, 'a one-character change in a real PDF was ACCEPTED');
	assert(r.problems.some((p) => p.kind === 'text-bytes'), JSON.stringify(r.problems.map((p) => p.kind)));
});

await test('CONTROL: an unmodified fixture still matches itself', async () => {
	// The control must fail for the right reason. If this did not pass, the two
	// tests above could be "detecting" a broken pipeline rather than corruption.
	const bytes = await load('text-1page.pdf');
	const sig = await extractTextSignature(await flatten(bytes), zip.inflate);
	const again = await extractTextSignature(await flatten(bytes), zip.inflate);
	assert(compareText(sig, again).ok, 'an unmodified fixture did not match itself');
});

await test('CONTROL: stripping every text operator from a real document is detected', async () => {
	const bytes = await load('text-3page.pdf');
	const flat = await flatten(bytes);
	assert(flat !== null, 'could not flatten the fixture');

	// Remove the operator from every `Tj` in the document, leaving the strings
	// in place. A page keeps its text payload objects and its fonts, renders
	// blank, and stays structurally valid - which is exactly the class of
	// damage the structural suite cannot see.
	const strippedText = flat.replace(/\(([^)]*)\)\s*Tj/g, '($1)');
	assert(strippedText !== flat, 'the corruption changed nothing');

	const originalSig = await extractTextSignature(flat, zip.inflate);
	const strippedSig = await extractTextSignature(strippedText, zip.inflate);
	assert(originalSig.pages[0].ops.length > 0, 'the fixture should contain text operations');

	const r = compareText(originalSig, strippedSig);
	assert(!r.ok, 'stripping every text operator from a real document was ACCEPTED');
	assert(
		r.problems.some((p) => p.kind === 'op-count' || p.kind === 'text-bytes'),
		`expected op-count or text-bytes, got ${JSON.stringify(r.problems.map((p) => p.kind))}`
	);
});

/* ── report ────────────────────────────────────────────────────────────────── */

report('');
report(`  documents with text  : ${withText.length}`);
report(`  documents without    : ${withoutText.length}  (image-only or blank pages - legitimate)`);
if (unsupportedTotal) {
	report(`  UNSUPPORTED pages    : ${unsupportedTotal}  (reported above as failures, never as passes)`);
}
report(`  page comparisons     : ${pageComparisons}`);

if (withText.length && VERBOSE) {
	report('\n  text-bearing runs:');
	for (const w of withText) report(`    ${w}`);
}

report('');
report(`${passed} passed, ${failed} failed`);
if (failures.length) {
	report('\nFailures:');
	for (const f of failures) report(`  - ${f}`);
}
report('');
process.exit(failed ? 1 : 0);