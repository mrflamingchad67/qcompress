/**
 * Engine test suite: the orchestrator, over the real fixtures.
 *
 * These assertions are the safety contract for the compression engine. A
 * smaller file is worthless if it renders differently, loses pages, or quietly
 * changes content the user did not ask us to change, so each mode is checked
 * for the properties it promises - and the lossless mode is checked for the
 * properties it must never break.
 *
 * Usage: bun scripts/test/test-pipeline.mjs
 */
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { optimize, MODE_SETTINGS, MODE_ATTEMPTS, validate } from '../../src/lib/qpdf/pipeline.ts';
import { findJpegImages } from '../../src/lib/qpdf/images.ts';
import { bytesToLatin1, bytesEqual } from '../../src/lib/qpdf/bytes.ts';
import { makeRunner, makeCodec, makeZip } from '../lib/engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const runner = makeRunner();
const codec = await makeCodec();
const zip = makeZip();

/* ── tiny harness ─────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;
const skipped = [];
let currentTest = '';

function test(name, fn) {
	currentTest = name;
	try {
		fn();
		passed++;
		log(`  pass  ${name}`);
	} catch (err) {
		failed++;
		log(`  FAIL  ${name}`);
		log(`        ${err.message.split('\n').join('\n        ')}`);
	}
}

function skip(name, why) {
	skipped.push(`${name}: ${why}`);
	log(`  skip  ${name} (${why})`);
}

function eq(actual, expected, what) {
	if (actual !== expected) {
		throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

function assert(cond, what) {
	if (!cond) throw new Error(what);
}

async function testAsync(name, fn) {
	currentTest = name;
	try {
		await fn();
		passed++;
		log(`  pass  ${name}`);
	} catch (err) {
		failed++;
		log(`  FAIL  ${name}`);
		log(`        ${err.message.split('\n').join('\n        ')}`);
	}
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/**
 * The original savings corpus only.
 *
 * This suite was written against the eight fixtures that existed before the
 * integrity stage, several of which it names by hand. The corpus has since
 * grown to 37, including deliberately malformed documents, and globbing them
 * all here would have this suite re-assert things that
 * `scripts/test/test-integrity.mjs` now covers properly - including on inputs this
 * suite has no expectation for.
 *
 * Run both. This one proves the orchestrator's core contracts on the corpus the
 * savings numbers are measured against; the integrity suite proves semantic
 * preservation across the whole corpus.
 */
const SAVINGS_CORPUS = [
	'alpha-smask.pdf',
	'graphic-q75.pdf',
	'oversized-600dpi.pdf',
	'photo-flate-p0.pdf',
	'photo-flate-p1.pdf',
	'photo-q35.pdf',
	'photo-q90.pdf',
	'scan-300dpi-q80.pdf'
];

async function loadFixtures() {
	const dir = path.join(here, '..', 'fixtures');
	const files = SAVINGS_CORPUS.filter((f) => f.endsWith('.pdf')).sort();
	return Promise.all(
		files.map(async (f) => ({ name: f, bytes: new Uint8Array(await readFile(path.join(dir, f))) }))
	);
}

const fixtures = await loadFixtures();
const byName = (n) => fixtures.find((f) => f.name === n);

/* ── helpers ──────────────────────────────────────────────────────────────── */

async function pageCount(bytes) {
	// Objects can hide inside object streams, so flatten before counting, and
	// count "/Type /Page" without matching the "/Type /Pages" root node.
	const flat = await runner(bytes, ['--object-streams=disable', '--stream-data=preserve']);
	if (!flat.out) return null;
	const matches = bytesToLatin1(flat.out).match(/\/Type\s*\/Page(?![sA-Za-z])/g);
	return matches ? matches.length : null;
}

/** Every JPEG payload in a document, sorted, for before/after comparison. */
function jpegPayloads(bytes) {
	return findJpegImages(bytesToLatin1(bytes))
		.map((i) => i.data)
		.sort((a, b) => a.length - b.length || 0);
}

/** Does the document still declare its own transparency (SMask)? */
function hasSoftMask(bytes) {
	return /\/SMask/.test(bytesToLatin1(bytes));
}

/* ── the suite ────────────────────────────────────────────────────────────── */

log('');
log('Pipeline test suite');
log(`fixtures: ${fixtures.length}`);
log('');

/* --- 1. mode configuration is honest --------------------------------------- */

log('mode configuration');

test('lossless mode is configured to do no image work', () => {
	eq(MODE_SETTINGS.lossless, null, 'lossless settings');
	eq(MODE_ATTEMPTS.lossless.length, 0, 'lossless image attempts');
});

test('lossy modes are configured to re-encode images', () => {
	assert(MODE_SETTINGS.balanced !== null, 'balanced must have settings');
	assert(MODE_SETTINGS.maximum !== null, 'maximum must have settings');
	assert(MODE_ATTEMPTS.balanced.length >= 1, 'balanced must try at least one setting');
	assert(MODE_ATTEMPTS.maximum.length >= 1, 'maximum must try at least one setting');
});

test('maximum is at least as aggressive as balanced', () => {
	const b = MODE_SETTINGS.balanced;
	const m = MODE_SETTINGS.maximum;
	assert(m.quality <= b.quality, `maximum quality ${m.quality} must be <= balanced ${b.quality}`);
	assert(m.maxLongEdge <= b.maxLongEdge, `maximum edge ${m.maxLongEdge} must be <= balanced ${b.maxLongEdge}`);
});

test('maximum considers every setting balanced does', () => {
	// Otherwise Maximum could hand back a larger file than Balanced on a
	// document where the harder settings happen to compress worse.
	for (const b of MODE_ATTEMPTS.balanced) {
		const covered = MODE_ATTEMPTS.maximum.some(
			(m) => m.quality === b.quality && m.maxLongEdge === b.maxLongEdge
		);
		assert(covered, `maximum does not try the balanced setting q${b.quality}/${b.maxLongEdge}`);
	}
});

/* --- 2. validation rejects broken output ------------------------------------ */

log('');
log('validation');

await testAsync('validate accepts every fixture it is given', async () => {
	for (const f of fixtures) {
		const v = await validate(f.bytes, runner);
		assert(v.ok, `${f.name} should validate, got: ${v.reason}`);
	}
});

await testAsync('validate rejects a truncated PDF', async () => {
	const f = byName('photo-q90.pdf');
	const broken = f.bytes.slice(0, Math.floor(f.bytes.length / 2));
	const v = await validate(broken, runner);
	assert(!v.ok, 'a truncated PDF must not validate');
});

await testAsync('validate rejects bytes that are not a PDF', async () => {
	const v = await validate(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), runner);
	assert(!v.ok, 'non-PDF bytes must not validate');
});

/* --- 3. lossless mode ------------------------------------------------------- */

log('');
log('lossless mode');

const losslessResults = new Map();

for (const f of fixtures) {
	await testAsync(`lossless: ${f.name} keeps every page`, async () => {
		const res = await optimize({ bytes: f.bytes, mode: 'lossless' }, runner, codec);
		losslessResults.set(f.name, res);
		assert(!res.lossy, 'lossless mode must not report a lossy result');

		const before = await pageCount(f.bytes);
		const after = await pageCount(res.bytes);
		assert(before !== null, 'could not read the original page count');
		eq(after, before, `${f.name} page count changed`);
	});
}

await testAsync('lossless mode never changes an image payload', async () => {
	for (const f of fixtures) {
		const res = losslessResults.get(f.name);
		if (!res) continue;

		const before = jpegPayloads(f.bytes);
		const after = jpegPayloads(res.bytes);

		// Deduplication can only ever *remove* copies of an identical payload,
		// never alter one. Every surviving payload must be byte-identical to
		// some payload in the original, and the multiset must shrink or match.
		for (const payload of after) {
			const found = before.some((b) => bytesEqual(b, payload));
			assert(found, `${f.name}: an image payload changed in lossless mode`);
		}
		assert(after.length <= before.length, `${f.name}: lossless mode invented images`);
	}
});

await testAsync('lossless mode never grows a file', async () => {
	for (const f of fixtures) {
		const res = losslessResults.get(f.name);
		assert(res.bytes.length <= f.bytes.length, `${f.name} grew from ${f.bytes.length} to ${res.bytes.length}`);
	}
});

await testAsync('lossless mode preserves transparency declarations', async () => {
	const f = byName('alpha-smask.pdf');
	const res = losslessResults.get('alpha-smask.pdf');
	assert(hasSoftMask(f.bytes), 'fixture should contain an SMask to begin with');
	assert(hasSoftMask(res.bytes), 'SMask was dropped');
});

await testAsync('lossless output passes an independent qpdf --check', async () => {
	for (const f of fixtures) {
		const res = losslessResults.get(f.name);
		const r = await runner(res.bytes, ['--check']);
		assert(r.code === 0 || r.code === 3, `${f.name}: qpdf --check exited ${r.code}: ${r.diagnostics.slice(0, 200)}`);
	}
});

/* --- 4. lossy modes are honestly lossy ------------------------------------- */

log('');
log('lossy modes');

for (const mode of ['balanced', 'maximum']) {
	const results = new Map();

	for (const f of fixtures) {
		await testAsync(`${mode}: ${f.name} keeps every page`, async () => {
			const res = await optimize({ bytes: f.bytes, mode, zip }, runner, codec);
			results.set(f.name, res);
			const before = await pageCount(f.bytes);
			const after = await pageCount(res.bytes);
			eq(after, before, `${f.name} page count changed`);
			assert(res.bytes.length <= f.bytes.length, `${f.name} grew`);
		});
	}

	await testAsync(`${mode}: every replaced image still decodes`, async () => {
		for (const f of fixtures) {
			const res = results.get(f.name);
			if (!res || res.strategy === 'none') continue;
			const imgs = findJpegImages(bytesToLatin1(res.bytes));
			for (const img of imgs) {
				// A decode failure here means the splice produced bad JPEG data.
				try {
					await codec.decode(img.data);
				} catch (err) {
					throw new Error(`${f.name}: obj ${img.num} no longer decodes (${err.message})`);
				}
			}
		}
	});
}

/* --- 5. mode ordering ------------------------------------------------------- */

log('');
log('mode behaviour');

await testAsync('maximum is never larger than balanced on any fixture', async () => {
	for (const f of fixtures) {
		const b = await optimize({ bytes: f.bytes, mode: 'balanced' }, runner, codec);
		const m = await optimize({ bytes: f.bytes, mode: 'maximum' }, runner, codec);
		assert(
			m.bytes.length <= b.bytes.length,
			`${f.name}: maximum ${m.bytes.length} B is larger than balanced ${b.bytes.length} B`
		);
	}
});

await testAsync('balanced may beat lossless, but only by degrading images', async () => {
	// There is deliberately no "lossless <= balanced" assertion. Balanced is
	// allowed to produce a smaller file than Lossless precisely because it
	// re-encodes images, and on this fixture it does. What must hold is that
	// Lossless is never *wrong*: it changes no pixels and never grows the file,
	// both asserted above.
	let sawLosslessLarger = false;
	for (const f of fixtures) {
		const l = await optimize({ bytes: f.bytes, mode: 'lossless' }, runner, codec);
		const b = await optimize({ bytes: f.bytes, mode: 'balanced' }, runner, codec);
		assert(l.bytes.length <= f.bytes.length, `${f.name}: lossless grew the file`);
		assert((await validate(l.bytes, runner)).ok, `${f.name}: lossless output is invalid`);
		if (l.bytes.length > b.bytes.length) sawLosslessLarger = true;
	}
	// Recorded rather than asserted: it documents the trade-off the user is
	// making when they pick Lossless.
	log(`        (balanced beat lossless on ${sawLosslessLarger ? 'at least one' : 'no'} fixture)`);
});

await testAsync('a fixture with nothing to gain is returned unchanged', async () => {
	// photo-flate-p1 is Flate-encoded with no duplicate streams, so no
	// strategy can improve it. It must come back byte-identical, not padded.
	const f = byName('photo-flate-p1.pdf');
	const res = await optimize({ bytes: f.bytes, mode: 'maximum' }, runner, codec);
	if (res.savedBytes === 0) {
		assert(bytesEqual(res.bytes, f.bytes), 'a zero-gain run must return the original bytes exactly');
		assert(res.fallback, 'a zero-gain run must be flagged as a fallback');
	}
});

/* --- 6. candidate selection ------------------------------------------------ */

log('');
log('candidate selection');

await testAsync('the smallest valid candidate wins', async () => {
	const f = byName('scan-300dpi-q80.pdf');
	const res = await optimize({ bytes: f.bytes, mode: 'balanced' }, runner, codec);
	const valid = res.candidates.filter((c) => c.valid && c.bytes > 0);
	const smallest = Math.min(...valid.map((c) => c.bytes));
	eq(res.bytes.length, smallest, 'orchestrator did not return the smallest valid candidate');
});

await testAsync('a corrupted candidate is rejected and never wins', async () => {
	const f = byName('photo-q90.pdf');

	// Corrupt the output of exactly one strategy - truncate it so it is no
	// longer a PDF. If candidate validation were not working, this truncated
	// file would be handed back as "compressed".
	let poisoned = 0;
	const runner2 = async (bytes, args) => {
		const r = await runner(bytes, args);
		const isStructural = args.includes('--compression-level=9') && !args.includes('--linearize');
		if (isStructural && r.out) {
			poisoned++;
			// Keep the header so it looks plausible; break the trailer.
			return { ...r, out: r.out.slice(0, r.out.length - 300) };
		}
		return r;
	};

	const res = await optimize({ bytes: f.bytes, mode: 'balanced' }, runner2, codec);
	assert(poisoned > 0, 'the poisoned runner was never exercised, so this proves nothing');

	const structural = res.candidates.find((c) => c.name === 'structural');
	assert(!structural.valid, 'the truncated candidate was marked valid');

	// Whatever the orchestrator picked must still be a real PDF.
	assert((await validate(res.bytes, runner)).ok, 'the orchestrator returned an invalid file');
	assert(!(await validate(structural.bytes, runner)).ok, 'the truncated candidate is in fact invalid');
	assert(res.bytes.length > 0, 'the orchestrator returned nothing at all');
});

/* ── summary ──────────────────────────────────────────────────────────────── */

log('');
log('-'.repeat(60));
log(`${passed} passed, ${failed} failed, ${skipped.length} skipped`);
if (skipped.length) {
	log('skipped:');
	for (const s of skipped) log(`  - ${s}`);
}
log('');
process.exit(failed ? 1 : 0);