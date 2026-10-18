/**
 * Does the text a READER sees survive compression?
 *
 * Part 1 of this stage proves the /ToUnicode mapping survives. That is
 * necessary but not sufficient: a document can keep every mapping intact and
 * still show a reader different characters, because the bytes are CIDs whose
 * meaning depends on which font was active when they were shown.
 *
 * THE INVARIANT
 *
 *   Compression must not alter the characters a conforming reader derives from
 *   the document's own /ToUnicode maps.
 *
 * WHAT IS NOT CLAIMED
 *
 * That the document's mapping is correct. A wrong CMap in the source stays
 * wrong. What is proved is that compression did not change what the source said.
 *
 * A page that cannot be decoded is UNKNOWN, never empty. An operation with no
 * font selected, or with a font that has no /ToUnicode, is counted as such and
 * excluded from the equality claim - not silently treated as blank text.
 *
 * Run: bun scripts/test/test-unicode-extraction.mjs [--verbose] [fixture ...]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { optimize } from '../../src/lib/qpdf/pipeline.ts';
import { bytesToLatin1 } from '../../src/lib/qpdf/bytes.ts';
import { parseObjects } from '../../src/lib/qpdf/structure.ts';
import { extractTextOps } from '../lib/textlayer.mjs';
import { fontCMapsForPage, decodePage, installInflate } from '../lib/unicode.mjs';
import { makeRunner, makeCodec, makeZip } from '../lib/engine.mjs';
import { FIXTURES } from '../lib/fixture-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const only = argv.filter((a) => !a.startsWith('--'));

const runner = makeRunner();
const codec = await makeCodec();
const zip = makeZip();
/* Must actually INFLATE, and must read its input as latin1: the document's
 * /ToUnicode streams are commonly Flate-wrapped (8 of 8 in one real document),
 * so a pass-through here would silently skip decoding on exactly the files that
 * matter most. */
installInflate(makeZip().inflate);

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

const load = (n) => readFile(path.join(here, '..', 'fixtures', n)).then((b) => new Uint8Array(b));

async function flatten(bytes) {
	const r = await runner(bytes, FLATTEN);
	return r.out ? bytesToLatin1(r.out) : null;
}

/** Page objects in document order, for a flattened document. */
function pagesOf(flatText) {
	const objects = parseObjects(flatText);
	return [...objects.entries()]
		.filter(([, o]) => /\/Type\s*\/Page[^s]/.test(o.dict ?? ''))
		.sort((a, b) => a[0] - b[0])
		.map(([num, o]) => ({ num, obj: o }));
}

/** Content stream text for a page, concatenating an array of /Contents. */
async function contentOf(flatText, objects, pageDict) {
	/* /Contents may be one stream or an array of them. A page with neither has
	 * no content, which is different from a page whose stream cannot be read. */
	const refs = [];
	const single = /\/Contents\s+(\d+)\s+0\s+R/.exec(pageDict);
	if (single) refs.push(parseInt(single[1], 10));
	const arr = /\/Contents\s*\[([^\]]*)\]/.exec(pageDict);
	if (arr) for (const m of arr[1].matchAll(/(\d+)\s+0\s+R/g)) refs.push(parseInt(m[1], 10));

	if (refs.length === 0) return '';

	const parts = [];
	for (const num of refs) {
		const o = objects.get(num);
		if (!o?.dict) return null;

		const at = flatText.indexOf('stream', o.dictEnd);
		if (at === -1) return null;
		let start = at + 'stream'.length;
		if (flatText[start] === '\r') start++;
		if (flatText[start] === '\n') start++;

		const len = parseInt(/\/Length\s+(\d+)/.exec(o.dict)?.[1] ?? '0', 10);
		if (!len) return null;

		const raw = flatText.slice(start, start + len);
		if (/\/Filter/.test(o.dict)) {
			/* qpdf's OUTPUT compresses content streams where the input did not,
			 * so the candidate side always takes this path. makeZip exposes an
			 * async `inflate`, not inflateSync - calling the latter throws and,
			 * caught below, silently reports the page as unreadable. */
			let inflated;
			try {
				/* latin1, not the default utf8. Buffer.from(string) defaults to
				 * utf8, which mangles every byte >= 0x80 and makes a valid
				 * zlib header fail with "incorrect header check". */
				inflated = await zip.inflate(Buffer.from(raw, 'latin1'));
			} catch {
				return null;
			}
			parts.push(Buffer.from(inflated).toString('latin1'));
			continue;
		}
		parts.push(raw);
	}
	return parts.join('\n');
}

/** Decode every page of a flattened document, or report why it could not. */
async function decodeDocument(flatText) {
	const objects = parseObjects(flatText);
	const pages = pagesOf(flatText);
	const out = [];

	for (const { num, obj } of pages) {
		const stream = await contentOf(flatText, objects, obj.dict);
		if (stream === null) {
			out.push({ page: num, unreadable: true });
			continue;
		}
		const ops = extractTextOps(stream);
		const cmaps = await fontCMapsForPage(flatText, obj);
		out.push({ page: num, unreadable: false, ...decodePage(ops, cmaps) });
	}
	return out;
}

/* â”€â”€ 1. decoding works at all â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

report('');
report('Unicode extraction');
report('  invariant: compression must not alter the characters a conforming');
report('             reader derives from the document /ToUnicode maps');

await test('CONTROL: the generated fixture decodes to its expected characters', async () => {
	const flat = await flatten(await load('type0-bfchar.pdf'));
	const pages = await decodeDocument(flat);

	assert(!pages.some((p) => p.unreadable), 'a page could not be read');
	const decoded = pages.map((p) => p.text).join('');
	assert(decoded.includes('Hello'), `expected "Hello" in the decoded text, got ${JSON.stringify(decoded)}`);
	assert(decoded.includes('QCompress'), `expected "QCompress", got ${JSON.stringify(decoded)}`);
	assert(
		pages.every((p) => p.fontless === 0 && p.noCMap === 0),
		`the fixture should decode every operation: ${JSON.stringify(pages)}`
	);
});

/* The fixture shows only the FIRST and LAST code of each run - 0030 0039 and
 * 0041 0045 - so the decoded text is exactly those four characters. Asserting
 * a character that is not on the page would be asserting a wrong expectation,
 * not a stricter one. */
await test('CONTROL: the bfrange fixture decodes the codes it shows', async () => {
	const flat = await flatten(await load('type0-bfrange.pdf'));
	const pages = await decodeDocument(flat);
	const decoded = pages.map((p) => p.text).join('');
	assert(decoded === '09AE', `expected "09AE" from codes 0030 0039 0041 0045, got ${JSON.stringify(decoded)}`);
});

/* â”€â”€ 2. the invariant, every fixture x every mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const candidates = Object.entries(FIXTURES)
	.map(([name, spec]) => ({ name, spec }))
	.filter(({ spec }) => spec.valid !== false)
	.filter(({ name }) => only.length === 0 || only.includes(name));

let comparedPages = 0;
let decodablePages = 0;
let charactersVerified = 0;
let skippedUnknown = 0;

for (const mode of ['lossless', 'balanced', 'maximum']) {
	if (VERBOSE) report(`\n[${mode}]`);

	for (const { name } of candidates) {
		await test(`${mode}: ${name}`, async () => {
			const bytes = await load(name);
			const beforeText = await flatten(bytes);
			assert(beforeText !== null, 'qpdf could not flatten the input');

			const before = await decodeDocument(beforeText);
			assert(
				!before.some((p) => p.unreadable),
				'a page content stream could not be read - a coverage gap, not a pass'
			);

			/* A page nothing can be decoded from is EXCLUDED and counted, never
			 * treated as an empty page. Comparing "" to "" would pass for a
			 * document whose text silently vanished. */
			const beforeDecodable = before.filter((p) => !p.fontless && !p.noCMap && p.ops > 0);
			skippedUnknown += before.length - beforeDecodable.length;

			if (beforeDecodable.length === 0) {
				if (VERBOSE) report(`  pass  ${mode}: ${name} â€” no decodable text (not counted as a comparison)`);
				return;
			}

			const res = await optimize({ bytes, mode, zip }, runner, codec);
			const afterText = await flatten(res.bytes);
			assert(afterText !== null, 'qpdf could not flatten the output');

			const after = await decodeDocument(afterText);
			assert(
				!after.some((p) => p.unreadable),
				'a candidate page content stream could not be read'
			);

			assert(
				after.length === before.length,
				`page count changed: ${before.length} -> ${after.length}`
			);

			for (let i = 0; i < beforeDecodable.length; i++) {
				const a = beforeDecodable[i];
				const b = after[i];
				comparedPages++;

				assert(
					a.ops === b.ops,
					`page ${a.page}: text operation count changed ${a.ops} -> ${b.ops}`
				);
				assert(
					a.text === b.text,
					`page ${a.page}: characters changed\n          before: ${JSON.stringify(a.text)}\n          after:  ${JSON.stringify(b.text)}`
				);
				assert(
					a.unmapped === b.unmapped,
					`page ${a.page}: unmapped code count changed ${a.unmapped} -> ${b.unmapped}`
				);
				decodablePages++;
				charactersVerified += a.text.length;
			}
		});
	}
}

/* â”€â”€ report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

report('');
report(`  pages compared          : ${comparedPages}`);
report(`  characters verified     : ${charactersVerified}`);
report(`  pages not decodable     : ${skippedUnknown}  (excluded and counted, never treated as empty)`);
report('');
report(`${passed} passed, ${failed} failed`);
if (failures.length) {
	report('\nFailures:');
	for (const f of failures) report(`  - ${f}`);
}
report('');

process.exit(failed ? 1 : 0);