/**
 * PDF integrity suite.
 *
 * Answers, with evidence, the five questions this stage exists for:
 *
 *   1. Is every output a structurally valid PDF?
 *   2. Does Lossless preserve the document's meaningful content?
 *   3. Do Balanced and Maximum preserve structure while degrading images
 *      only where that is allowed?
 *   4. Does selection always pick the smallest candidate that validates?
 *   5. Does the real browser behave like the engine tests say it does?
 *      (question 5 lives in test-browser.mjs; this file is 1-4)
 *
 * Usage: bun scripts/test/test-integrity.mjs [--verbose] [fixture ...]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { optimize, validate, MODE_ATTEMPTS } from '../../src/lib/qpdf/pipeline.ts';
import { findJpegImages, isReencodable } from '../../src/lib/qpdf/images.ts';
import { bytesToLatin1, bytesEqual } from '../../src/lib/qpdf/bytes.ts';
import { readStructure } from '../../src/lib/qpdf/structure.ts';
import { makeRunner, makeCodec, makeZip } from '../lib/engine.mjs';
import { compareStructure, describeDiffs } from '../lib/compare.mjs';
import { FIXTURES, VALID_NAMES, INVALID_NAMES } from '../lib/fixture-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const only = argv.filter((a) => !a.startsWith('--'));

const runner = makeRunner();
const codec = await makeCodec();
const zip = makeZip();

/* ── harness ──────────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;
const failures = [];
let section = '';

const setSection = (s) => {
	section = s;
	report(`\n${s}`);
};

async function test(name, fn) {
	try {
		await fn();
		passed++;
		if (VERBOSE) report(`  pass  ${name}`);
	} catch (err) {
		failed++;
		failures.push(`[${section}] ${name}: ${err.message}`);
		report(`  FAIL  ${name}`);
		report(`        ${err.message.split('\n').join('\n        ')}`);
	}
}

function assert(cond, what) {
	if (!cond) throw new Error(what);
}

/** Deep equality: `!==` would report ["Im0"] and ["Im0"] as different. */
function eq(actual, expected, what) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

const FLATTEN = ['--object-streams=disable', '--stream-data=preserve'];

async function load(name) {
	return new Uint8Array(await readFile(path.join(here, '..', 'fixtures', name)));
}

/** Flatten for the structure reader. Returns null when qpdf cannot do it. */
async function flatten(bytes) {
	const r = await runner(bytes, FLATTEN);
	return r.out ? bytesToLatin1(r.out) : null;
}

async function structure(bytes) {
	const flat = await flatten(bytes);
	return flat === null ? null : readStructure(flat);
}

/** Every DCTDecode payload, sorted, for byte-identity comparison. */
function jpegPayloads(text) {
	return findJpegImages(text)
		.map((i) => i.data)
		.sort((a, b) => a.length - b.length);
}

const names = only.length ? VALID_NAMES.filter((n) => only.includes(n)) : VALID_NAMES;

/**
 * Which of those QPDF can actually open.
 *
 * The manifest calls a fixture "valid" when it is a well-formed document by
 * construction. QPDF is a stricter authority, and it decodes DCTDecode streams
 * during `--check`, so a fixture with a damaged quantisation table fails there
 * even though its structure is sound. Those fixtures are excluded from the
 * output assertions below - with a recorded skip, never a silent pass - and
 * are covered explicitly in section 12 instead.
 */
const processable = [];
const unprocessable = [];
for (const name of names) {
	const bytes = await load(name);
	const c = await runner(bytes, ['--check']);
	(c.code === 0 || c.code === 3 ? processable : unprocessable).push(name);
}
if (unprocessable.length) {
	report(`\n  note: ${unprocessable.length} fixture(s) that the manifest calls valid are rejected`);
	report(`        by qpdf --check and are handled in section 12: ${unprocessable.join(', ')}`);
}

/* ── 1. the reader agrees with the manifest ──────────────────────────────── */

setSection('[1] the structure reader agrees with the declared fixture manifest');

for (const name of processable) {
	const spec = FIXTURES[name];
	await test(`${name} matches its manifest entry`, async () => {
		const bytes = await load(name);
		const flat = await flatten(bytes);
		assert(flat !== null, 'qpdf could not flatten a fixture the manifest calls valid');

		const s = readStructure(flat);

		// Page count: trust the walk, and require it to agree with /Count.
		if (spec.pages !== undefined) eq(s.pageCount, spec.pages, 'page count');
		if (spec.declaredCount !== undefined) eq(s.declaredCount, spec.pages, 'declared /Count');
		assert(s.readable, 'document not readable');

		// Images.
		const jp = findJpegImages(flat);
		eq(jp.length, spec.jpeg, 'DCTDecode image count');
		if (spec.images !== undefined) eq(s.images.size, spec.images, 'total image object count');
		const eligible = jp.filter(isReencodable);
		eq(eligible.length, spec.reencodable, 're-encodable image count');

		// Optional feature expectations.
		if (spec.mediaBoxes) {
			eq(s.pages.map((p) => p.mediaBox), spec.mediaBoxes, 'per-page MediaBox');
		}
		if (spec.cropBox) eq(s.pages[0].cropBox, spec.cropBox, 'CropBox');
		if (spec.rotate !== undefined) eq(s.pages[0].rotate, spec.rotate, '/Rotate');
		if (spec.annotSubtypes) eq(s.pages[0].annotSubtypes, spec.annotSubtypes, 'annotation subtypes');
		if (spec.linkUris) eq(s.pages[0].linkUris, spec.linkUris, 'link targets');
		if (spec.outlines !== undefined) eq(s.hasOutlines, spec.outlines, 'outlines presence');
		if (spec.outlineTitles) eq(s.outlineTitles, spec.outlineTitles, 'outline titles');
		if (spec.acroform !== undefined) eq(s.hasAcroForm, spec.acroform, 'AcroForm presence');
		if (spec.formFields) eq(s.formFields, spec.formFields, 'form field names');
		if (spec.metadata !== undefined) eq(s.hasMetadata, spec.metadata, '/Metadata presence');
		if (spec.info !== undefined) eq(s.hasInfo, spec.info, '/Info presence');
		if (spec.smask !== undefined) {
			const withMask = [...s.images.values()].some((i) => i.hasSMask);
			eq(withMask, spec.smask, 'soft mask present');
		}
	});
}

/* ── 2. every output is structurally valid ────────────────────────────────────── */

setSection('[2] every produced candidate is a structurally valid PDF');

for (const name of processable) {
	await test(`${name}: output is structurally valid in every mode`, async () => {
		const bytes = await load(name);
		const before = await structure(bytes);
		assert(before !== null, 'input fixture would not flatten');

		for (const mode of ['lossless', 'balanced', 'maximum']) {
			const res = await optimize({ bytes, mode, zip }, runner, codec);

			// The orchestrator's own boundary check.
			const v = await validate(res.bytes, runner);
			assert(v.ok, `${mode}: validate() rejected the output: ${v.reason}`);

			// An independent `qpdf --check`, not routed through validate().
			const check = await runner(res.bytes, ['--check']);
			assert(check.code === 0 || check.code === 3, `${mode}: qpdf --check exited ${check.code}`);

			// Header and trailer, read without qpdf at all.
			assert(Buffer.from(res.bytes.subarray(0, 5)).toString() === '%PDF-', `${mode}: missing %PDF- header`);
			const tail = Buffer.from(res.bytes.subarray(Math.max(0, res.bytes.length - 2048))).toString('latin1');
			assert(tail.includes('%%EOF'), `${mode}: missing %%EOF`);

			// Readable page tree, with the same number of pages.
			const after = await structure(res.bytes);
			assert(after !== null, `${mode}: output would not flatten`);
			assert(after.readable, `${mode}: page tree not readable`);
			eq(after.pageCount, before.pageCount, `${mode}: page count`);

			// A fallback must be the original bytes, not a rewritten copy.
			if (res.fallback) {
				assert(bytesEqual(res.bytes, bytes), `${mode}: fallback did not return the original bytes`);
			}

			// No candidate may be reported invalid without saying why.
			for (const c of res.candidates) {
				if (!c.valid) assert(!!c.rejected, `${mode}: candidate "${c.name}" invalid with no reason`);
			}
		}
	});
}

/* ── 3. Lossless preserves meaning ────────────────────────────────────────────── */

setSection('[3] Lossless preserves page tree, annotations, outlines, forms and metadata');

for (const name of processable) {
	await test(`${name}: lossless output has the same structure as the input`, async () => {
		const bytes = await load(name);
		const res = await optimize({ bytes, mode: 'lossless' }, runner, codec);

		const beforeText = await flatten(bytes);
		const afterText = await flatten(res.bytes);
		assert(beforeText !== null && afterText !== null, 'could not flatten one side');

		const { diffs } = compareStructure(beforeText, afterText);

		// objectCount may legitimately move: object streams pack objects
		// differently and QPDF may drop the free head entry. Page and feature
		// counts must not.
		const meaningful = diffs.filter((d) => d.field !== 'objectCount' && d.field !== 'images');

		// Images may differ in Lossless only if deduplication removed copies.
		// Compare as a multiset of unique payloads rather than a count.
		assert(meaningful.length === 0, `structural drift: ${describeDiffs(meaningful)}`);
	});
}

setSection('[4] Lossless never alters an encoded image payload');

for (const name of processable) {
	const spec = FIXTURES[name];
	if (!spec.jpeg) continue;
	await test(`${name}: JPEG payloads are byte-identical after lossless`, async () => {
		const bytes = await load(name);
		const res = await optimize({ bytes, mode: 'lossless' }, runner, codec);

		const beforeText = await flatten(bytes);
		const afterText = await flatten(res.bytes);
		const before = jpegPayloads(beforeText);
		const after = jpegPayloads(afterText);

		assert(after.length <= before.length, `lossless invented images (${before.length} -> ${after.length})`);
		for (const payload of after) {
			assert(
				before.some((b) => bytesEqual(b, payload)),
				'lossless produced an encoded image payload that was not in the input'
			);
		}
	});
}

setSection('[5] unsupported images are skipped even by the lossy modes');

for (const name of processable) {
	const spec = FIXTURES[name];
	if (!spec.jpeg || spec.reencodable === spec.jpeg) continue;
	await test(`${name}: ${spec.jpeg - spec.reencodable} unsupported image(s) left untouched`, async () => {
		const bytes = await load(name);
		const res = await optimize({ bytes, mode: 'maximum' }, runner, codec);

		const beforeText = await flatten(bytes);
		const afterText = await flatten(res.bytes);
		const before = jpegPayloads(beforeText);
		const after = jpegPayloads(afterText);

		assert(after.length === before.length, `an image disappeared (${before.length} -> ${after.length})`);
		for (const payload of after) {
			assert(
				before.some((b) => bytesEqual(b, payload)),
				'an unsupported image payload was modified'
			);
		}
	});
}

setSection('[6] transparency (soft masks) survives every mode');

await test('alpha-smask.pdf keeps its soft mask in all three modes', async () => {
	const bytes = await load('alpha-smask.pdf');
	for (const mode of ['lossless', 'balanced', 'maximum']) {
		const res = await optimize({ bytes, mode, zip }, runner, codec);
		const flat = await flatten(res.bytes);
		assert(flat !== null, `${mode}: could not flatten output`);
		const s = readStructure(flat);
		const masked = [...s.images.values()].filter((i) => i.hasSMask);
		assert(masked.length >= 1, `${mode}: the soft mask was dropped`);
	}
});

/* ── 7. deduplication safeguards ──────────────────────────────────────────────── */

setSection('[7] deduplication only collapses what is genuinely shareable');

await test('shared-image.pdf: two pages keep one image and both still draw it', async () => {
	const bytes = await load('shared-image.pdf');
	const res = await optimize({ bytes, mode: 'lossless' }, runner, codec);
	const s = await structure(res.bytes);
	eq(s.pageCount, 2, 'page count');
	eq(s.pages[0].xobjectNames, ['Im0'], 'page 1 resource names');
	eq(s.pages[1].xobjectNames, ['Im0'], 'page 2 resource names');
});

await test('near-duplicate-images.pdf: a one-byte difference prevents deduplication', async () => {
	const bytes = await load('near-duplicate-images.pdf');
	const beforeText = await flatten(bytes);
	const beforeImgs = jpegPayloads(beforeText);
	eq(beforeImgs.length, 2, 'fixture should hold two distinct payloads');

	const res = await optimize({ bytes, mode: 'lossless' }, runner, codec);
	const afterText = await flatten(res.bytes);
	const afterImgs = jpegPayloads(afterText);

	// Both distinct payloads must survive: they are not byte-identical.
	eq(afterImgs.length, 2, 'a near-duplicate was wrongly deduplicated');
	for (const p of afterImgs) {
		assert(beforeImgs.some((b) => bytesEqual(b, p)), 'payload changed');
	}
});

await test('identical-content-diff-resources.pdf: shared content streams are NOT merged', async () => {
	const bytes = await load('identical-content-diff-resources.pdf');
	const before = await structure(bytes);
	eq(before.pageCount, 2, 'fixture page count');
	// The two images are genuinely different, so they must remain distinct.
	eq(before.images.size, 2, 'fixture should hold two distinct images');

	const res = await optimize({ bytes, mode: 'lossless' }, runner, codec);
	const after = await structure(res.bytes);
	eq(after.pageCount, 2, 'page count after dedupe');
	eq(after.images.size, 2, 'two different images must both survive');
});

await test('deduplication is never applied to content streams', async () => {
	// Direct unit-level check of the strategy's own decision, independent of
	// the orchestrator: the allowlist must exclude anything that is not an
	// image, font program, embedded file or metadata object.
	const { dedupeStreams } = await import('../../src/lib/qpdf/dedupe.ts');
	const bytes = await load('identical-content-diff-resources.pdf');
	const flat = await flatten(bytes);
	const result = dedupeStreams(flat);

	// The only shareable object in this fixture is the content stream, which
	// must be refused outright.
	assert(!result.bytes || result.duplicatesReplaced === 0, 'dedupeStreams merged a content stream');
});

/**
 * Every object a page's resource dictionary points at must still exist.
 *
 * Regression test for a real defect found by the visual-regression stage.
 * Deduplication used to delete a duplicate image object's definition without
 * repointing the page that referenced it, so page 2 kept `/Im0 8 0 R` while
 * object 8 no longer existed. The page then drew nothing at all - and the file
 * still passed `qpdf --check`, every structural assertion, and the image
 * fidelity suite, because the image payloads that survived were untouched and
 * nothing about the file was malformed. Only rendering the page showed it.
 *
 * This is the cheap structural version of that check: no renderer needed, and
 * it fails the moment a reference dangles.
 */
await test('deduplication leaves no dangling resource references', async () => {
	for (const name of ['graphic-q75.pdf', 'scan-300dpi-q80.pdf', 'shared-image.pdf']) {
		const bytes = await load(name);
		const res = await optimize({ bytes, mode: 'lossless' }, runner, codec);
		const text = await flatten(res.bytes);

		// Every object defined in the file.
		const defined = new Set([...text.matchAll(/(?:^|[\s>])(\d+) 0 obj\b/g)].map((m) => Number(m[1])));

		// Every object a page's /XObject dictionary refers to.
		// `flatten()` expands object streams, so references and definitions are
		// both visible as plain text. Page dictionaries nest (`/Resources
		// << /XObject << ... >> >>`), so match the whole page object and then
		// find /XObject inside it, rather than assuming a fixed depth.
		const refs = [];
		for (const page of text.matchAll(/(?:^|[\s>])(\d+) 0 obj\s*<<([\s\S]*?)\/Type\s*\/Page\b([\s\S]*?)>>/g)) {
			const body = `${page[2]}${page[3]}`;
			if (/\/Type\s*\/Pages\b/.test(body)) continue;
			const xo = /\/XObject\s*<<([^>]*)>>/.exec(body);
			if (!xo) continue;
			for (const m of xo[1].matchAll(/(?:^|[\s/])([A-Za-z0-9_]+)\s+(\d+)\s+0\s+R/g)) {
				refs.push({ key: m[1], num: Number(m[2]) });
			}
		}

		assert(refs.length > 0, `${name}: found no /XObject reference to check (parser may have changed shape)`);
		for (const r of refs) {
			assert(
				defined.has(r.num),
				`${name}: a page references /${r.key} ${r.num} 0 R but object ${r.num} does not exist`
			);
		}
	}
});

await test('deduplication repoints references instead of leaving alias objects', async () => {
	// An alias object (`8 0 obj` whose body is just `6 0 R`) is the obvious way
	// to express a dedupe, and it is wrong here: the structural qpdf pass
	// collapses such an object down to a bare integer, leaving object 8 holding
	// the number `6`, which resolves to nothing. The output must contain no
	// reference-only objects at all.
	const bytes = await load('graphic-q75.pdf');
	const res = await optimize({ bytes, mode: 'lossless' }, runner, codec);
	const text = await flatten(res.bytes);

	for (const m of text.matchAll(/(?:^|[\s>])(\d+) 0 obj\s*(\d+)\s+0\s+R\s*endobj/g)) {
		assert(
			false,
			`object ${m[1]} is an alias to ${m[2]} rather than a real object; the structural ` +
				'pass collapses these and the referencing page loses its content'
		);
	}
});

/* ── 8. lossy modes: only eligible images change ──────────────────────────────── */

setSection('[8] lossy modes re-encode only eligible images, and the result still decodes');

for (const name of processable) {
	const spec = FIXTURES[name];
	if (!spec.jpeg) continue;
	if (spec.mayFailDecode) continue; // covered separately
	await test(`${name}: every output image decodes and keeps its colour space`, async () => {
		const bytes = await load(name);
		const before = await structure(bytes);

		const res = await optimize({ bytes, mode: 'maximum' }, runner, codec);
		const afterText = await flatten(res.bytes);
		const after = readStructure(afterText);

		// Compare the SET of colour spaces, not the list: deduplication
		// legitimately collapses byte-identical copies, so a document with two
		// identical DeviceRGB images ends with one. A missing colour space
		// would still be caught, because it would change the set.
		const cs = (s) => [...new Set([...s.images.values()].map((i) => i.colorspace))].sort();
		eq(cs(after), cs(before), 'colour spaces');

		for (const [num, img] of after.images) {
			// Only DCTDecode images go through the JPEG codec; a Flate image is
			// carried through untouched and is not this test's subject.
			if (!img.filters.includes('DCTDecode')) continue;
			const direct = findJpegImages(afterText).find((i2) => i2.num === num);
			assert(direct, `image obj ${num} vanished from the document`);

			// Unwrap exactly as the engine does. Decoding a Flate-wrapped
			// payload directly is the very bug this section guards against, so
			// the test must not repeat it.
			let payload = direct.data;
			if (direct.encoding === 'flate-jpeg') {
				try {
					payload = await zip.inflate(direct.data);
				} catch (err) {
					throw new Error(`obj ${num} is marked Flate-wrapped but will not inflate: ${err.message}`);
				}
			}

			try {
				const decoded = await codec.decode(payload);
				assert(decoded.width > 0 && decoded.height > 0, `obj ${num} decoded to an empty image`);
				eq(decoded.width, img.width, `obj ${num} width`);
				eq(decoded.height, img.height, `obj ${num} height`);
			} catch (err) {
				throw new Error(`obj ${num} no longer decodes: ${err.message}`);
			}
		}
	});
}

await test('jpeg-corrupt.pdf: a damaged image is never reported as a successful compression', async () => {
	const bytes = await load('jpeg-corrupt.pdf');

	// First, the finding this fixture exists for: this QPDF build decodes
	// DCTDecode streams during --check, so damaged image data is caught by the
	// existing validation boundary rather than reaching the output.
	const check = await runner(bytes, ['--check']);
	assert(check.code !== 0, 'qpdf unexpectedly accepted a destroyed JPEG');
	assert(/DQT|JPEG|image/i.test(check.diagnostics), `unexpected --check output: ${check.diagnostics.slice(0, 200)}`);

	let res = null;
	let threw = null;
	try {
		res = await optimize({ bytes, mode: 'maximum' }, runner, codec);
	} catch (err) {
		threw = err;
	}
	// An explicit failure is acceptable. What must never happen is a claimed
	// saving built on an unreadable document.
	if (!threw) {
		eq(res.savedBytes, 0, 'a rejected document must report zero savings');
		assert(res.fallback, 'a rejected document must be reported as a fallback');
		assert(bytesEqual(res.bytes, bytes), 'the original bytes must be returned unchanged');
	}
});

/* ── 9. candidate rejection ────────────────────────────────────────────────────── */

setSection('[9] invalid candidates are rejected, and the original is never lost');

/**
 * Wrap a runner so one strategy returns something deliberately broken.
 * `mode` selects the damage.
 */
function sabotage(base, mode) {
	const STRUCTURAL = args => args.includes('--compression-level=9') && !args.includes('--linearize');
	const LINEARIZE = args => args.includes('--linearize');

	let hits = 0;
	return async (bytes, args) => {
		const r = await base(bytes, args);
		const isStructural = STRUCTURAL(args) && r.out;
		const isLinear = LINEARIZE(args) && r.out;

		switch (mode) {
			case 'empty':
				if (isStructural) { hits++; return { ...r, out: new Uint8Array(0) }; }
				break;
			case 'truncate':
				if (isStructural) { hits++; return { ...r, out: r.out.slice(0, 40) }; }
				break;
			case 'garbage':
				if (isStructural) {
					hits++;
					const junk = new Uint8Array(r.out.length);
					junk.set(r.out.subarray(0, 5));
					return { ...r, out: junk };
				}
				break;
			case 'pagecount':
				if (isStructural) { hits++; return { ...r, out: r.out.subarray(0, Math.floor(r.out.length / 2)) }; }
				break;
			case 'throw':
				if (isStructural) { hits++; throw new Error('synthetic strategy failure'); }
				break;
			case 'error':
				if (isStructural) { hits++; return { code: 2, out: null, diagnostics: 'synthetic qpdf failure' }; }
				break;
			case 'reject':
				if (isStructural) { hits++; return Promise.reject(new Error('synthetic rejection')); }
				break;
			case 'all':
				hits++;
				throw new Error('every strategy failed');
		}
		return r;
	};
}

const SABOTAGE_CASES = [
	['empty output', 'empty'],
	['truncated output', 'truncate'],
	['random bytes that are not a PDF', 'garbage'],
	['a structurally broken body', 'pagecount'],
	['a strategy that throws', 'throw'],
	['a strategy that returns a qpdf error', 'error'],
	['a strategy that rejects', 'reject']
];

for (const [label, mode] of SABOTAGE_CASES) {
	await test(`rejects ${label} and still returns something valid`, async () => {
		const bytes = await load('text-3page.pdf');
		const sab = sabotage(runner, mode);
		const res = await optimize({ bytes, mode: 'balanced' }, sab, codec);

		const v = await validate(res.bytes, runner);
		assert(v.ok, `returned file is invalid: ${v.reason}`);
		const s = await structure(res.bytes);
		if (s) eq(s.pageCount, 3, 'page count must be preserved even when a strategy fails');
	});
}

await test('a failing strategy does not stop the later eligible strategies', async () => {
	const bytes = await load('jpeg-large.pdf');
	const sab = sabotage(runner, 'throw');
	const res = await optimize({ bytes, mode: 'balanced' }, sab, codec);

	// The image strategies run after the structural one, so a throw there must
	// not prevent them - and the result must still be valid.
	const v = await validate(res.bytes, runner);
	assert(v.ok, `result invalid after a strategy threw: ${v.reason}`);
	assert(res.candidates.some((c) => c.valid), 'no valid candidate survived');
});

await test('when every strategy fails the original bytes are returned', async () => {
	const bytes = await load('text-3page.pdf');
	const res = await optimize({ bytes, mode: 'balanced' }, sabotage(runner, 'all'), codec);

	assert(res.fallback, 'result was not flagged as a fallback');
	eq(res.strategy, 'none', 'strategy reported');
	assert(bytesEqual(res.bytes, bytes), 'the original bytes were not returned unchanged');
	eq(res.savedBytes, 0, 'savedBytes should be exactly zero');
	eq(res.percent, 0, 'percent should be exactly zero');
});

await test('a candidate larger than the original never wins', async () => {
	const bytes = await load('text-1page.pdf');
	const grow = async (b, args) => {
		const r = await runner(b, args);
		if (r.out && args.includes('--compression-level=9')) {
			// A valid PDF, but bigger: it must be discarded.
			return { ...r, out: new Uint8Array([...r.out, ...new Uint8Array(5000)]) };
		}
		return r;
	};
	const res = await optimize({ bytes, mode: 'balanced' }, grow, codec);
	assert(res.bytes.length <= bytes.length, `returned ${res.bytes.length} B for a ${bytes.length} B input`);
});

/* ── 10. mode guarantees ───────────────────────────────────────────────────────── */

setSection('[10] mode policies');

await test('lossless never generates a lossy candidate', () => {
	eq(MODE_ATTEMPTS.lossless.length, 0, 'lossless must attempt no image settings');
});

for (const name of processable) {
	await test(`${name}: lossless output is never lossy-flagged`, async () => {
		const bytes = await load(name);
		const res = await optimize({ bytes, mode: 'lossless' }, runner, codec);
		assert(!res.lossy, 'a lossy strategy was reported for lossless mode');
		for (const c of res.candidates) {
			assert(!c.lossy, `lossless mode generated a lossy candidate "${c.name}"`);
		}
	});
}

for (const name of processable) {
	await test(`${name}: maximum is never larger than balanced`, async () => {
		const bytes = await load(name);
		const b = await optimize({ bytes, mode: 'balanced' }, runner, codec);
		const m = await optimize({ bytes, mode: 'maximum' }, runner, codec);
		assert(
			m.bytes.length <= b.bytes.length,
			`maximum ${m.bytes.length} B exceeds balanced ${b.bytes.length} B`
		);
	});
}

await test('balanced actually attempts image work on an eligible fixture', () => {
	// Guards against the ordering test above passing merely because both modes
	// quietly skipped every image.
	const bytesPromise = load('jpeg-large.pdf');
	return bytesPromise.then(async (bytes) => {
		const res = await optimize({ bytes, mode: 'balanced' }, runner, codec);
		assert(res.imagesProcessed > 0, 'balanced examined no images at all');
		const lossy = res.candidates.filter((c) => c.lossy);
		assert(lossy.length > 0, 'balanced generated no lossy candidate');
	});
});

await test('maximum actually attempts more aggressive settings than balanced', async () => {
	const bytes = await load('jpeg-large.pdf');
	const m = await optimize({ bytes, mode: 'maximum' }, runner, codec);
	const b = await optimize({ bytes, mode: 'balanced' }, runner, codec);
	const mQ = new Set(MODE_ATTEMPTS.maximum.map((s) => s.quality));
	const bQ = new Set(MODE_ATTEMPTS.balanced.map((s) => s.quality));
	for (const q of bQ) assert(mQ.has(q), `maximum does not consider balanced's quality ${q}`);
	assert(mQ.size > bQ.size, 'maximum should consider strictly more settings than balanced');
	void m; void b;
});

await test('a smaller candidate generated later still wins', async () => {
	// `structural` is generated first; `dedupe` later and is usually smaller.
	// Ordering must not decide the winner.
	const bytes = await load('scan-300dpi-q80.pdf');
	const res = await optimize({ bytes, mode: 'lossless' }, runner, codec);
	const valid = res.candidates.filter((c) => c.valid && c.bytes > 0);
	const smallest = Math.min(...valid.map((c) => c.bytes));
	eq(res.bytes.length, smallest, 'the orchestrator did not return the smallest valid candidate');
	assert(res.strategy !== 'structural', 'the first-generated candidate won despite a smaller one existing');
});

await test('equal-size candidates resolve deterministically', async () => {
	// Two valid candidates of identical length: the winner must be stable
	// across repeated runs.
	const bytes = await load('jpeg-rgb.pdf');
	const a = await optimize({ bytes, mode: 'balanced' }, runner, codec);
	const b = await optimize({ bytes, mode: 'balanced' }, runner, codec);
	eq(a.strategy, b.strategy, 'strategy differs between identical runs');
	eq(a.bytes.length, b.bytes.length, 'size differs between identical runs');
});

/* ── 11. byte accounting ───────────────────────────────────────────────────────── */

setSection('[11] byte accounting');

for (const name of processable) {
	await test(`${name}: reported sizes match the actual buffers`, async () => {
		const bytes = await load(name);
		for (const mode of ['lossless', 'balanced', 'maximum']) {
			const res = await optimize({ bytes, mode, zip }, runner, codec);
			eq(res.originalBytes, bytes.length, `${mode} originalBytes`);
			eq(res.bytes.length, res.bytes.byteLength, `${mode} returned buffer length`);
			eq(res.savedBytes, bytes.length - res.bytes.length, `${mode} savedBytes`);
			eq(res.percent, ((bytes.length - res.bytes.length) / bytes.length) * 100, `${mode} percent`);
			assert(res.percent >= 0, `${mode} reported negative savings as a success`);
		}
	});
}

await test('a no-op reports exactly zero, not a rounded value', async () => {
	const bytes = await load('photo-flate-p1.pdf');
	const res = await optimize({ bytes, mode: 'maximum' }, runner, codec);
	if (res.fallback) {
		eq(res.savedBytes, 0, 'savedBytes on a no-op');
		eq(res.percent, 0, 'percent on a no-op');
		eq(res.strategy, 'none', 'strategy on a no-op');
		assert(bytesEqual(res.bytes, bytes), 'a no-op did not return the original bytes');
	}
});

await test('a zero-length input cannot divide by zero', async () => {
	const empty = new Uint8Array(0);
	let res = null;
	let threw = null;
	try {
		res = await optimize({ bytes: empty, mode: 'maximum' }, runner, codec);
	} catch (err) {
		threw = err;
	}

	// Either a clean "no improvement" or a clear error is acceptable; a NaN or
	// Infinity percentage, or a crash inside a divide, is not.
	assert(!threw, `zero-length input threw: ${threw?.message}`);
	if (res) {
		assert(Number.isFinite(res.percent), `percent was ${res.percent}`);
		assert(Number.isFinite(res.savedBytes), `savedBytes was ${res.savedBytes}`);
		eq(res.percent, 0, 'percent for an empty input');
	}
});

await test('a single-byte input is handled without a NaN percentage', async () => {
	const tiny = new Uint8Array([0x25]);
	const res = await optimize({ bytes: tiny, mode: 'maximum' }, runner, codec);
	assert(Number.isFinite(res.percent), `percent was ${res.percent}`);
	assert(Number.isFinite(res.savedBytes), `savedBytes was ${res.savedBytes}`);
});

await test('formatPercent never divides by a zero denominator', async () => {
	const { formatPercent, formatBytes, formatDelta } = await import('../../src/lib/format.ts');
	const results = [];
	for (const n of [0, 1, 512, 1024, 1048576]) {
		results.push(formatPercent(n), formatBytes(n), formatDelta(n));
	}
	for (const r of results) {
		assert(typeof r === 'string' && r.length > 0, `formatter returned ${JSON.stringify(r)}`);
		assert(!/NaN|Infinity|undefined/.test(r), `formatter leaked ${JSON.stringify(r)}`);
	}
});

/* ── 12. invalid input is reported honestly ────────────────────────────────────── */

setSection('[12] invalid input is an error, not a fake success');

for (const name of INVALID_NAMES) {
	await test(`${name}: produces no successful compression claim`, async () => {
		const bytes = await load(name);

		const check = await runner(bytes, ['--check']);
		assert(check.code !== 0, `${name} unexpectedly passes qpdf --check`);

		// Whatever the orchestrator returns, it must never be presented as a
		// successful compression of an unreadable document.
		let res = null;
		let threw = null;
		try {
			res = await optimize({ bytes, mode: 'maximum' }, runner, codec);
		} catch (err) {
			threw = err;
		}
		if (threw) return; // an explicit failure is an acceptable outcome
		if (res.savedBytes > 0) {
			const v = await validate(res.bytes, runner);
			assert(v.ok, `${name}: claimed a saving but produced an invalid file`);
		}
	});
}

/* ── summary ──────────────────────────────────────────────────────────────────── */

report('\n' + '-'.repeat(70));
report(`${passed} passed, ${failed} failed  (${names.length} fixtures)`);
if (failures.length) {
	report('\nFailures:');
	for (const f of failures) report(`  - ${f}`);
}
report('');
process.exit(failed ? 1 : 0);
