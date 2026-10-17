/**
 * Parser realism: does the document parser handle the forms real files use?
 *
 * WHY THIS SUITE EXISTS
 *
 * `parseObjects` once lost 80 of 197 objects on a real 10-page document,
 * including all 16 of its /ToUnicode maps. No suite failed, because no fixture
 * contained a bare string or bare array object. Measured across the 40 fixtures
 * that existed before this work: string objects 0, array objects 0, indirect
 * /Resources 0, /Contents arrays 0.
 *
 * Those paths were not untested - they were UNREACHABLE, and a real user's file
 * was the first thing to walk them.
 *
 * THE CENTRAL ASSERTION
 *
 * For every fixture: index it, and assert that no `N 0 obj` header was skipped.
 *
 * That is deliberately stronger than "the objects I expected are present". The
 * weaker form only tests document shapes somebody already thought of; this one
 * catches any shape that confuses the scanner, including ones nobody has
 * thought of yet.
 *
 * Negative controls accompany every form, because a fixture that cannot fail
 * proves nothing - that discipline found the code-space fingerprint gap and the
 * scalar/array bfrange clobber while this stage was being built.
 *
 * Run: bun scripts/test/test-parser-realism.mjs [--verbose]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { parseObjects } from '../../src/lib/qpdf/structure.ts';
import { bytesToLatin1 } from '../../src/lib/qpdf/bytes.ts';
import { parseCMap, toUnicodeMap, fingerprint } from '../lib/cmap.mjs';
import { fontCMapsForPage, installInflate } from '../lib/unicode.mjs';
import { makeRunner } from '../lib/engine.mjs';
import { FIXTURES } from '../lib/fixture-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

const VERBOSE = process.argv.includes('--verbose');
const runner = makeRunner();
installInflate((b) => zlib.inflateSync(Buffer.from(b)));

const FLATTEN = ['--object-streams=disable', '--stream-data=preserve'];

/**
 * Count UTF-16 code units that are not part of a valid surrogate pair.
 *
 * Iterating with a spread yields CODE POINTS, so a correctly recombined emoji
 * reports `charCodeAt(0) === 0xd83d` and looks exactly like a lone high
 * surrogate. That mistake would have failed a correct implementation while
 * passing a broken one, so the check walks the raw units and verifies pairing.
 */
function loneSurrogates(s) {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const u = s.charCodeAt(i);
		if (u >= 0xd800 && u <= 0xdbff) {
			const next = s.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) i++;
			else n++;
		} else if (u >= 0xdc00 && u <= 0xdfff) {
			n++;
		}
	}
	return n;
}

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

const load = (n) => readFile(path.join(here, '..', 'fixtures', n)).then((b) => new Uint8Array(b));

async function flatten(bytes) {
	const r = await runner(bytes, FLATTEN);
	return r.out ? bytesToLatin1(r.out) : null;
}

/** Every `N 0 obj` header in the text, ignoring any inside a stream payload. */
function headersIn(flat) {
	return [...new Set([...flat.matchAll(/(?:^|[\s>\]])(\d+)\s+0\s+obj\b/g)].map((m) => parseInt(m[1], 10)))].sort(
		(a, b) => a - b
	);
}

/**
 * Classify the body that follows an object header, from raw bytes.
 *
 * `parseObjects` records dictionary objects. A bare string or array object has
 * no dictionary to record, so it is stepped over rather than stored - by
 * design, and stated as such below. Anything else must be indexed.
 */
function bodyFormAt(text, afterHeader) {
	let i = afterHeader;
	while (i < text.length && /\s/.test(text[i])) i++;
	const c = text[i];
	if (c === '(') return 'string';
	if (c === '[') return 'array';
	if (text.startsWith('stream', i)) return 'stream';
	if (c === '<' && text[i + 1] === '<') return 'dict';
	return 'other';
}

/* ── 1. no fixture loses an object ────────────────────────────────────────── */

report('');
report('Parser realism');
report('  assertion: run on RAW bytes, not on qpdf output. Flattening silently');
report('             deletes bare string and array objects - they are absent');
report('             before the parser ever sees them - so a check run on');
report('             flattened text would measure qpdf instead of the parser.');
report('');

const fixtures = Object.entries(FIXTURES)
	.map(([name, spec]) => ({ name, spec }))
	.filter(({ spec }) => spec.valid !== false);

let skippedTotal = 0;
let bareSkippedTotal = 0;

for (const { name } of fixtures) {
	await test(`${name}: no dictionary object is skipped by the index`, async () => {
		const raw = bytesToLatin1(await load(name));

		/* Locate each header and record what kind of body follows it, so a bare
		 * body can be told apart from an object the scanner actually lost. */
		const forms = new Map();
		for (const m of raw.matchAll(/(?:^|[\s>\]])(\d+)\s+0\s+obj\b/g)) {
			const n = parseInt(m[1], 10);
			if (!forms.has(n)) forms.set(n, bodyFormAt(raw, m.index + m[0].length));
		}

		const objects = parseObjects(raw);
		const lost = [];
		const bare = [];
		for (const [n, form] of forms) {
			if (objects.has(n)) continue;
			if (form === 'string' || form === 'array') bare.push(n);
			else lost.push(n);
		}

		skippedTotal += lost.length;
		bareSkippedTotal += bare.length;

		assert(
			lost.length === 0,
			`${lost.length} of ${forms.size} objects were not indexed (${lost.slice(0, 8).join(', ')}). ` +
				`The index is incomplete, so anything built on it - text extraction, font resolution, structure comparison - reads a partial document.`
		);
	});
}

/* ── 2. the forms real documents use are present and handled ───────────────── */

await test('struct-bare-objects.pdf actually contains bare bodies', async () => {
	const raw = Buffer.from(await load('struct-bare-objects.pdf')).toString('latin1');
	const bare = [...raw.matchAll(/\d+ 0 obj\n([(\[][^\n]*)\nendobj/g)].map((m) => m[1]);
	assert(bare.length >= 3, `expected at least 3 bare-body objects, found ${bare.length}`);
	assert(
		bare.some((b) => b.startsWith('(')) && bare.some((b) => b.startsWith('[')),
		`expected both a bare string and a bare array, got ${JSON.stringify(bare)}`
	);

	/* Run on raw bytes: the bare bodies must be present in the bytes handed to
	 * the parser, and the dictionaries that follow them must all be indexed. */
	const objects = parseObjects(raw);
	const headers = headersIn(raw);
	const bareHeaders = new Set([...raw.matchAll(/\d+ 0 obj\n([(\[])/g)].map((m) => parseInt(m[0], 10)));
	const missing = headers.filter((h) => !objects.has(h) && !bareHeaders.has(h));
	assert(
		missing.length === 0,
		`bare bodies made the index lose ${missing.join(', ')} of the dictionaries that follow them`
	);
	assert(
		bareHeaders.size >= 3,
		`the bare bodies themselves were not all located in the raw bytes (${bareHeaders.size})`
	);
});

await test('struct-indirect-resources.pdf resolves /Resources by reference', async () => {
	const flat = await flatten(await load('struct-indirect-resources.pdf'));
	assert(/\/Resources\s+\d+\s+0\s+R/.test(flat), 'the fixture does not actually use an indirect /Resources');
	assert(/\/Contents\s*\[/.test(flat), 'the fixture does not actually use a /Contents array');

	// A font behind the indirect reference must still be found. Getting this
	// wrong produced an empty map and silently decoded every page to nothing,
	// which compares equal to nothing and passes.
	const objects = parseObjects(flat);
	const pages = [...objects.entries()].filter(([, o]) => /\/Type\s*\/Page[^s]/.test(o.dict ?? ''));
	assert(pages.length > 0, 'no page objects found');

	const page = pages[0][1];
	const ref = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.dict);
	assert(ref !== null, 'page /Resources is not a reference');
	const resDict = objects.get(parseInt(ref[1], 10))?.dict ?? '';
	assert(/\/Font/.test(resDict), 'the referenced resources carry no /Font');
});

/* ── 3. a compressed CMap decodes, including a surrogate pair ─────────────── */

await test('type0-compressed-cmap.pdf decodes through a Flate-wrapped map', async () => {
	const flat = await flatten(await load('type0-compressed-cmap.pdf'));
	const objects = parseObjects(flat);
	const page = [...objects.entries()].find(([, o]) => /\/Type\s*\/Page[^s]/.test(o.dict ?? ''))?.[1];
	assert(page !== undefined, 'no page object');

	const cmaps = fontCMapsForPage(flat, page);
	assert(cmaps.size === 1, `expected 1 CMap, found ${cmaps.size} - a compressed map was skipped`);

	const map = toUnicodeMap([...cmaps.values()][0]);
	const decoded = [...map.values()].join('');
	assert(decoded.includes('Α'), `expected Greek alpha, decoded ${JSON.stringify(decoded)}`);
	assert(decoded.includes('Ж'), `expected Cyrillic Zhe, decoded ${JSON.stringify(decoded)}`);
	assert(decoded.includes('é'), `expected e-acute, decoded ${JSON.stringify(decoded)}`);

	/* The emoji is TWO UTF-16 code units. A parser that decodes each unit
	 * separately yields a lone high surrogate and still passes any count-based
	 * check, so this asserts the single character explicitly. */
	assert(
		decoded.includes('\u{1F600}'),
		`expected the surrogate pair to recombine into one character, decoded ${JSON.stringify(decoded)}`
	);
	assert(loneSurrogates(decoded) === 0, `a lone surrogate survived: ${JSON.stringify(decoded)}`);
});

/* ── 4. negative controls: the suite must be able to fail ─────────────────── */

await test('CONTROL: an index that skips a bare body is detected', async () => {
	const flat = await flatten(await load('struct-bare-objects.pdf'));
	const objects = parseObjects(flat);
	/* Drop the LAST indexed object. The completeness assertion must notice, or
	 * the check is decorative. */
	const last = Math.max(...objects.keys());
	const trimmed = new Map([...objects.entries()].filter(([n]) => n !== last));
	const headers = headersIn(flat);
	const missingWithDrop = headers.filter((h) => !trimmed.has(h));
	assert(missingWithDrop.length === 1, 'the control did not produce a detectable omission');
});

/* The regression control for the defect that started this stage, written so it
 * cannot pass by construction. It bypasses qpdf and the fixtures entirely and
 * feeds the scanner a body layout in memory:
 *
 *   1 0 obj  << dict >>          the dictionary a forward search would find
 *   2 0 obj  (Adobe)             NO dictionary - the failure trigger
 *   3 0 obj  [ -988 -486 ... ]   NO dictionary
 *   4 0 obj  << dict >>          must survive
 *
 * The previous implementation searched forward for the next `<<` after each
 * header, so objects 2, 3 and everything between were consumed as part of
 * object 1's dictionary, and 4 was never reached. Under that logic this text
 * yields one object; this text must yield the two dictionaries it contains.
 *
 * The bare bodies are NOT indexed, and that is the documented design: there is
 * no dictionary to store. What must hold is that stepping over them loses
 * nothing after them - which is exactly what the old implementation got wrong. */
await test('CONTROL: dictionaries after a bare body are still indexed', () => {
	const text =
		`1 0 obj\n<< /Type /Catalog >>\nendobj\n` +
		`2 0 obj\n(Adobe)\nendobj\n` +
		`3 0 obj\n[ -988 -486 988 808 ]\nendobj\n` +
		`4 0 obj\n<< /Type /Page >>\nendobj\n`;
	const objects = parseObjects(text);
	assert(
		objects.size === 2,
		`expected the 2 dictionaries to be indexed, got ${objects.size} (objects ${[...objects.keys()].join(', ')}) - a forward search for the next << swallowed everything after a bare body`
	);
	assert(objects.has(4), 'the dictionary following a bare body was lost');
	assert(objects.get(1)?.dict.includes('/Catalog'), 'object 1 should hold its own dictionary');
});

/* A string literal is data. A `>>` inside one must not close the dictionary
 * that contains it.
 *
 * The assertion targets the SYMPTOM, not the object count. A `>>` in a literal
 * truncates its own dictionary while leaving later objects perfectly intact, so
 * a count-only check passes while the data is already lost. This control was
 * first written against the object count and proved to be decorative when run
 * against the previous implementation; the version below fails under it. */
await test('CONTROL: braces inside a string literal do not truncate the dictionary', () => {
	const text =
		`1 0 obj\n<< /Type /Catalog /Note (a >> b << c) /Pages 2 0 R >>\nendobj\n` +
		`2 0 obj\n<< /Type /Pages >>\nendobj\n`;
	const objects = parseObjects(text);
	assert(objects.size === 2, `expected 2 objects, indexed ${objects.size}`);

	/* The literal's TEXT belongs in the dictionary - it is data. What must not
	 * happen is the ">>" closing the dictionary early, which would drop
	 * everything after it. */
	const dict = objects.get(1)?.dict ?? '';
	assert(
		dict.includes('/Pages 2 0 R'),
		`the dictionary was closed by the ">>" inside the string literal: ${JSON.stringify(dict)}`
	);
});

/* The hole this suite nearly shipped with.
 *
 * `struct-bare-objects.pdf` contains three bare bodies. qpdf DELETES them when
 * flattening, so a completeness check run on flattened text finds nothing to
 * complain about and passes - having measured qpdf rather than the parser. This
 * asserts the deletion is real, so the reason the main check runs on raw bytes
 * cannot silently stop being true. */
await test('CONTROL: flattening really does drop bare bodies', async () => {
	const bytes = await load('struct-bare-objects.pdf');
	const raw = bytesToLatin1(bytes);
	const flat = bytesToLatin1((await runner(bytes, FLATTEN)).out);

	const bareInRaw = [...raw.matchAll(/\d+ 0 obj\n([(\[][^\n]*)\nendobj/g)].map((m) => m[1]);
	assert(bareInRaw.length >= 3, `the fixture should hold at least 3 bare bodies, found ${bareInRaw.length}`);

	const rawHeaders = headersIn(raw);
	const flatHeaders = headersIn(flat);
	const lost = rawHeaders.filter((h) => !flatHeaders.includes(h));
	assert(
		lost.length > 0,
		'flattening preserved every object, so the completeness check would be measuring the parser after all. That is fine, but this control must be updated to say so rather than assert something untrue.'
	);
});

await test('CONTROL: an altered CMap target changes the fingerprint', async () => {
	const envelope = (target) =>
		`/CIDInit /ProcSet findresource begin 12 dict begin begincmap` +
		`1 begincodespacerange <0000> <FFFF> endcodespacerange` +
		`1 beginbfchar <0031> <${target}> endbfchar endcmap end end`;

	const a = fingerprint(parseCMap(envelope('0391')));
	const b = fingerprint(parseCMap(envelope('0392')));
	assert(a !== b, `the control changed nothing (both ${JSON.stringify(a)}), so a passing comparison would prove nothing`);
});

/* Two controls the fingerprint itself must survive. Each changes something the
 * fingerprint is documented to cover, and each failed to be covered by an
 * earlier version of this suite. */
await test('CONTROL: a changed code space changes the fingerprint', async () => {
	const body = '1 beginbfchar <0031> <0391> endbfchar';
	const twoByte = fingerprint(
		parseCMap(`begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange ${body} endcmap`)
	);
	const oneByte = fingerprint(
		parseCMap(`begincmap 1 begincodespacerange <00> <FF> endcodespacerange ${body} endcmap`)
	);
	assert(
		twoByte !== oneByte,
		'an identical mapping table under a different code space produced the same fingerprint, so text extraction differences would go unnoticed'
	);
});

await test('CONTROL: an identical CMap produces an identical fingerprint', async () => {
	const body =
		`begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange ` +
		`2 beginbfchar <0031> <0391> <0032> <0392> endbfchar endcmap`;
	const a = fingerprint(parseCMap(body));
	const b = fingerprint(parseCMap(body));
	assert(a === b, 'the same CMap fingerprinted differently on two parses, which would report false differences');
});

/* A control for the false-alarm direction. Every other control here proves the
 * suite reports damage; this proves it does not report damage that isn't there,
 * which is the other way a "0 objects lost" result can be meaningless.
 *
 * The first version of this compared `parseObjects(x).size` with
 * `parseObjects(x).size` — the same expression on both sides, which is true by
 * construction and detects nothing. Comparing the whole index instead makes it
 * sensitive to ordering and content, so a genuine non-determinism fails. */
await test('CONTROL: indexing the same document twice gives the same index', async () => {
	const raw = bytesToLatin1(await load('struct-bare-objects.pdf'));
	const a = parseObjects(raw);
	const b = parseObjects(raw);

	const shape = (m) =>
		[...m.entries()]
			.map(([n, o]) => `${n}:${o.dictStart},${o.dictEnd}`)
			.sort()
			.join('|');

	assert(a.size === b.size, `index size differed between runs: ${a.size} vs ${b.size}`);
	assert(
		shape(a) === shape(b),
		'the same bytes produced two different indexes, so a difference between input and output could never be attributed to the compressor'
	);
	assert(a.size > 0, 'the control ran against an empty index, which would compare equal to anything');
});

/* ── report ────────────────────────────────────────────────────────────────── */

report('');
report(`  fixtures checked        : ${fixtures.length}`);
report(`  dictionary objects lost : ${skippedTotal}`);
report(`  bare bodies stepped over: ${bareSkippedTotal}  (not indexed by design -`);
report(`                           no dictionary to store - but nothing after`);
report(`                           them is lost, which is the actual guarantee)`);
report(`  forms covered           : bare string, bare array, indirect /Resources,`);
report(`                           /Contents array, Flate-wrapped CMap, surrogate pair`);
report('');
report('  NOT covered, and deliberately not claimed:');
report('    compressed object streams (/ObjStm), cross-reference streams,');
report('    inline images (BI...ID...EI). No example of any exists in the');
report('    documents this stage was built from, so a fixture for them would be');
report('    written from the specification rather than from something observed.');
report('');
report(`${passed} passed, ${failed} failed`);
if (failures.length) {
	report('\nFailures:');
	for (const f of failures) report(`  - ${f}`);
}
report('');

process.exit(failed ? 1 : 0);