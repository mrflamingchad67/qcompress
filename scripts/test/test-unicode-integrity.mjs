/**
 * Unicode-layer integrity: does compression preserve what the text MEANS?
 *
 * THE INVARIANT
 *
 *   Compression must not alter the mapping from a font's character codes to
 *   Unicode characters.
 *
 * WHY THIS IS SEPARATE FROM THE TEXT SUITE
 *
 * test-text-integrity compares the bytes a page hands to Tj / TJ / ' / ". For a
 * Type0 font with /Identity-H encoding those bytes are CIDs - glyph indices,
 * not characters. `0048` is only an "H" because the font's /ToUnicode CMap says
 * so. So that suite proves the glyph indices survived, and says nothing about
 * whether they still mean anything.
 *
 * The consequence is concrete: a compressor that deleted every /ToUnicode CMap
 * in a document would pass every other suite in this repository. The pages
 * would render identically, the CIDs would be byte-identical, the structure
 * would compare clean - and search would find nothing, copy-paste would yield
 * garbage, and a screen reader would read nothing at all.
 *
 * WHAT IS AND IS NOT CLAIMED
 *
 * This proves the MAPPING is unchanged. It does not claim the document's
 * mapping was correct to begin with - a wrong CMap in the source stays wrong.
 * What it rules out is compression changing what the source said.
 *
 * Run: bun scripts/test/test-unicode-integrity.mjs [--verbose] [fixture ...]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { optimize } from '../../src/lib/qpdf/pipeline.ts';
import { bytesToLatin1 } from '../../src/lib/qpdf/bytes.ts';
import { makeRunner, makeCodec, makeZip } from '../lib/engine.mjs';
import { FIXTURES } from '../lib/fixture-manifest.mjs';
import { parseCMap, fingerprint, toUnicodeMap } from '../lib/cmap.mjs';

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

/** Object number -> dictionary boundaries, for a flattened document. */
function indexObjects(text) {
	const objects = new Map();
	const re = /(?:^|[\r\n>\]])(\d+)\s+0\s+obj\s*</g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const num = parseInt(m[1], 10);
		const start = m.index + m[0].length - 1;
		let depth = 0;
		let end = -1;
		for (let i = start; i < text.length; i++) {
			if (text[i] === '<' && text[i + 1] === '<') { depth++; i++; continue; }
			if (text[i] === '>' && text[i + 1] === '>') { depth--; i++; if (depth === 0) { end = i + 1; break; } }
		}
		if (end !== -1) objects.set(num, { dict: text.slice(start, end), dictEnd: end });
	}
	return objects;
}

/** Decoded stream body, inflated when Flate-wrapped. */
function streamBody(text, objects, num) {
	const o = objects.get(num);
	if (!o) return null;
	const at = text.indexOf('stream', o.dictEnd);
	if (at === -1) return null;
	let ds = at + 6;
	if (text[ds] === '\r') ds++;
	if (text[ds] === '\n') ds++;
	const len = parseInt(/\/Length\s+(\d+)/.exec(o.dict)?.[1] ?? '0', 10);
	let body = Buffer.from(text.slice(ds, ds + len), 'latin1');
	if (/\/Filter/.test(o.dict)) {
		try {
			body = zlib.inflateSync(body);
		} catch {
			return null;
		}
	}
	return body.toString('latin1');
}

/**
 * Every /ToUnicode CMap in a flattened document.
 *
 * Keyed by CMap CONTENT, not object number: QPDF renumbers freely, so comparing
 * object numbers would report correct renumbering as loss.
 */
function collectCMaps(text) {
	const objects = indexObjects(text);
	const refs = new Set([...text.matchAll(/\/ToUnicode\s+(\d+)\s+0\s+R/g)].map((m) => parseInt(m[1], 10)));
	const out = [];
	for (const num of refs) {
		const body = streamBody(text, objects, num);
		if (body === null) {
			out.push({ num, unreadable: true, fingerprint: null, mappings: 0 });
			continue;
		}
		const c = parseCMap(body);
		out.push({ num, unreadable: false, fingerprint: fingerprint(c), mappings: c.toUnicode.size, decoded: toUnicodeMap(c) });
	}
	return out;
}

const load = (n) => readFile(path.join(here, '..', 'fixtures', n)).then((b) => new Uint8Array(b));
const flatten = async (bytes) => {
	const r = await runner(bytes, FLATTEN);
	return r.out ? bytesToLatin1(r.out) : null;
};

/* ── 1. every fixture x every mode ─────────────────────────────────────────── */

const candidates = Object.entries(FIXTURES)
	.map(([name, spec]) => ({ name, spec }))
	.filter(({ spec }) => spec.valid !== false)
	.filter(({ name }) => only.length === 0 || only.includes(name));

let comparisons = 0;
let withCMaps = 0;
let totalMappings = 0;

report('');
report('Unicode-layer integrity');
report('  invariant: compression must not alter the mapping from a font’s');
report('             character codes to Unicode characters');
report(`  fixtures : ${candidates.length}`);

for (const mode of ['lossless', 'balanced', 'maximum']) {
	report(`\n[${mode}]`);

	for (const { name } of candidates) {
		const label = `${mode}: ${name}`;

		await test(label, async () => {
			const bytes = await load(name);
			const beforeText = await flatten(bytes);
			assert(beforeText !== null, 'qpdf could not flatten the input');

			const before = collectCMaps(beforeText);
			const res = await optimize({ bytes, mode, zip }, runner, codec);
			const afterText = await flatten(res.bytes);
			assert(afterText !== null, 'qpdf could not flatten the output');

			const after = collectCMaps(afterText);

			const unreadable = [
				...before.filter((c) => c.unreadable).map((c) => `original obj ${c.num}`),
				...after.filter((c) => c.unreadable).map((c) => `candidate obj ${c.num}`)
			];
			assert(
				unreadable.length === 0,
				`/ToUnicode CMap could not be decoded — a coverage gap, not a pass:\n  ${unreadable.join('\n  ')}`
			);

			if (before.length === 0) {
				/* No CMap means no composite-font encoding. Preservation is
				 * vacuous here, not verified, and saying so keeps the count honest. */
				if (VERBOSE) report(`  pass  ${label} — no /ToUnicode CMap (nothing to preserve)`);
				return;
			}

			assert(
				after.length === before.length,
				`/ToUnicode CMap count changed: ${before.length} -> ${after.length}`
			);

			/* Compare the multiset of mapping FINGERPRINTS. Object numbers may be
			 * renumbered; the mappings themselves may not change. */
			const beforeFp = before.map((c) => c.fingerprint).sort();
			const afterFp = after.map((c) => c.fingerprint).sort();

			const lost = beforeFp.filter((f) => !afterFp.includes(f));
			assert(lost.length === 0, `${lost.length} /ToUnicode CMap(s) changed or were lost`);

			const gained = afterFp.filter((f) => !beforeFp.includes(f));
			assert(gained.length === 0, `${gained.length} unexpected /ToUnicode CMap(s) appeared`);

			// Decoded characters must match, not merely the count. This is what a
			// search index or a screen reader would actually see.
			const beforeText_ = [...before].map((c) => [...(c.decoded ?? new Map())].sort().join('')).sort();
			const afterText_ = [...after].map((c) => [...(c.decoded ?? new Map())].sort().join('')).sort();
			assert(
				JSON.stringify(beforeText_) === JSON.stringify(afterText_),
				'decoded characters differ although the fingerprints matched'
			);

			comparisons += before.length;
			const mappings = before.reduce((n, c) => n + c.mappings, 0);
			totalMappings += mappings;
			withCMaps++;
		});
	}
}

/* ── 2. negative control: a mangled CMap IS detected ───────────────────────── */

report('');
report('[negative control] a damaged /ToUnicode CMap is rejected');

/**
 * Corrupt one /ToUnicode mapping in a REAL fixture, in place.
 *
 * The substitution is the same length and happens inside the decoded CMap body,
 * so the file stays byte-length identical, stays a valid PDF, and the ONLY thing
 * that changed is what one character means. That is the failure this suite
 * exists to catch, and a control that broke the file instead would be testing
 * qpdf rather than the comparison.
 */
function corruptOneMapping(text) {
	const objects = indexObjects(text);
	const refs = [...new Set([...text.matchAll(/\/ToUnicode\s+(\d+)\s+0\s+R/g)].map((m) => parseInt(m[1], 10)))];

	for (const num of refs) {
		const o = objects.get(num);
		if (!o) continue;
		const at = text.indexOf('stream', o.dictEnd);
		if (at === -1) continue;
		let ds = at + 6;
		if (text[ds] === '\r') ds++;
		if (text[ds] === '\n') ds++;
		const len = parseInt(/\/Length\s+(\d+)/.exec(o.dict)?.[1] ?? '0', 10);
		if (len === 0) continue;

		// The generated fixtures store their CMaps uncompressed, so the body can
		// be edited in place. A Flate-wrapped one is skipped rather than
		// recompressed, because reflate would change the length and shift the xref.
		if (/\/Filter/.test(o.dict)) continue;

		const s = text.slice(ds, ds + len);

		/* Target a real MAPPING, never the codespacerange. Both are pairs of
		 * <hex> tokens, so an earlier version of this control matched
		 * `<0000> <FFFF>` in begincodespacerange and reported a pass while
		 * changing nothing about decoding. Scope the search to the mapping
		 * blocks. */
		const blocks = [...s.matchAll(/beginbfchar([\s\S]*?)endbfchar|beginbfrange([\s\S]*?)endbfrange/g)];
		assert(blocks.length > 0, 'the fixture CMap has no mapping block to corrupt');

		const body = blocks[0][1] ?? blocks[0][2];
		const m = /<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4})>/.exec(body);
		assert(m !== null, 'could not find a mapping pair inside the mapping block');

		// Flip the last hex digit of one target: a different character, same width.
		const last = m[2].slice(-1);
		const flipped = m[2].slice(0, -1) + (last === '0' ? '1' : '0');
		const patchedBody = body.slice(0, m.index) + `<${m[1]}> <${flipped}>` + body.slice(m.index + m[0].length);
		assert(patchedBody.length === body.length, 'the patch must preserve length');
		const patched = s.slice(0, m.index) + patchedBody.slice(body.indexOf('<') >= 0 ? 0 : 0, patchedBody.length) && patchedBody;
		const finalText = s.slice(0, blocks[0].index + (blocks[0][1] ? 1 : 0)) + patchedBody +
			s.slice(blocks[0].index + (blocks[0][1] ? 1 : 0) + body.length);
		assert(finalText.length === s.length, 'the patched CMap must preserve total length');

		return { text: text.slice(0, ds) + finalText + text.slice(ds + len), from: m[2], to: flipped };
	}
	return null;
}

/* The control uses the new fixtures, which carry a real CMap. Using a fixture
 * with no CMap would make it pass for the wrong reason. */
await test('CONTROL: one changed character in a real CMap is rejected', async () => {
	const bytes = await load('type0-bfchar.pdf');
	const originalText = await flatten(bytes);
	assert(originalText !== null, 'fixture would not flatten');

	const before = collectCMaps(originalText);
	assert(before.length > 0, 'fixture has no /ToUnicode CMap, so the control would prove nothing');

	const corrupted = corruptOneMapping(originalText);
	assert(corrupted !== null, 'could not corrupt a mapping');

	const after = collectCMaps(corrupted.text);
	const beforeFp = before.map((c) => c.fingerprint).sort();
	const afterFp = after.map((c) => c.fingerprint).sort();

	const lost = beforeFp.filter((f) => !afterFp.includes(f));
	assert(
		lost.length > 0,
		`changing one mapped character from ${corrupted.from} to ${corrupted.to} was ACCEPTED`
	);

	// The mapping COUNT is unchanged, so a count-only check would pass. The
	// comparison has to be sensitive to content, not just quantity.
	assert(before.length === after.length, 'the control changed the number of CMaps, which is not what it is testing');
});

await test('CONTROL: a document with no CMap is not compared', async () => {
	const bytes = await load('text-1page.pdf');
	const text = await flatten(bytes);
	assert(text !== null, 'fixture would not flatten');
	assert(
		collectCMaps(text).length === 0,
		'expected a fixture with no /ToUnicode CMap; the vacuous case is no longer being exercised'
	);
});

await test('CONTROL: one changed character moves the fingerprint', async () => {
	const original = fingerprint(parseCMap('1 beginbfchar <0001> <0041> <0002> <0042> endbfchar'));
	const patched = fingerprint(parseCMap('1 beginbfchar <0001> <0041> <0002> <0043> endbfchar'));
	assert(original !== patched, 'changing one mapped character did not change the fingerprint');
});

/* The control above found this one. The code space decides how many bytes make
 * up each source code, so changing it alters every extracted character while the
 * mapping table stays byte-identical. Fingerprinting only `toUnicode` let that
 * through. */
await test('CONTROL: a changed codespacerange moves the fingerprint', async () => {
	const original = fingerprint(
		parseCMap('1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0021> <0048> endbfchar')
	);
	const patched = fingerprint(
		parseCMap('1 begincodespacerange <0000> <FF00> endcodespacerange 1 beginbfchar <0021> <0048> endbfchar')
	);
	assert(original !== patched, 'changing the codespacerange did not change the fingerprint');
});

await test('CONTROL: an unmodified document matches itself', async () => {
	const bytes = await load('type0-bfchar.pdf');
	const a = collectCMaps(await flatten(bytes));
	const b = collectCMaps(await flatten(bytes));
	assert(
		JSON.stringify(a.map((c) => c.fingerprint)) === JSON.stringify(b.map((c) => c.fingerprint)),
		'an unmodified document did not match itself'
	);
});

/* ── report ────────────────────────────────────────────────────────────────── */

report('');
report(`  fixtures with a /ToUnicode CMap : ${withCMaps}`);
report(`  CMap comparisons               : ${comparisons}`);
report(`  mappings verified              : ${totalMappings}`);
report('');
report(`${passed} passed, ${failed} failed`);
if (failures.length) {
	report('\nFailures:');
	for (const f of failures) report(`  - ${f}`);
}
report('');

process.exit(failed ? 1 : 0);