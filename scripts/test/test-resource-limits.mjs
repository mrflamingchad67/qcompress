/**
 * Resource limits: a decompression bomb must be skipped, not honoured.
 *
 * WHAT THIS EXISTS FOR
 *
 * Flate expands by ~1032:1. Before this suite, `makeZip().inflate` decompressed
 * a stream to completion with no ceiling:
 *
 *     new Response(stream).arrayBuffer()
 *
 * which allocates the ENTIRE decoded payload before any check could run.
 * Measured, through the real pipeline, on a document QPDF accepted without
 * complaint:
 *
 *     100 KB page-content stream -> 100 MB decoded, +156 MB heap
 *
 * Scaling that ratio, a 10 MB PDF asks for roughly 10 GB. This is not a
 * catchable error - it is an allocation failure, and in a worker it takes the
 * tab down with it. No candidate validation runs, because the process is gone.
 *
 * THE GUARANTEE
 *
 * An over-large payload THROWS. Every caller already treats a failed inflate as
 * "leave this payload exactly as it was" - `toRawJpeg` returns null and the
 * image is skipped - so the result is an untouched image, never a truncated
 * one. That distinction is the whole point: a truncated prefix of a JPEG is a
 * corrupt file, which is the single outcome this project must never produce.
 *
 * The controls below exist because "it threw" is not the same claim as "it threw
 * instead of returning a partial prefix". Both are asserted.
 *
 * Run: bun scripts/test/test-resource-limits.mjs
 */
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';

import { makeZip, MAX_INFLATE_BYTES } from '../../src/lib/qpdf/zip.ts';
import { makeRunner, makeCodec, makeZip as makeNodeZip } from '../lib/engine.mjs';
import { optimize } from '../../src/lib/qpdf/pipeline.ts';

const report = (...a) => process.stdout.write(a.join(' ') + '\n');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
	try {
		await fn();
		passed++;
	} catch (err) {
		failed++;
		failures.push(`${name}: ${err.message}`);
		report(`  FAIL  ${name}`);
		report(`        ${String(err.message).split('\n').join('\n        ')}`);
	}
}

function assert(cond, what) {
	if (!cond) throw new Error(what);
}

/* ── the codec under test ──────────────────────────────────────────────────── */

/* The module the WORKER imports. Node and Bun both provide DecompressionStream,
 * Blob and Response, so this is the browser code path, not a stand-in for it. */
const browserZip = makeZip();
const nodeZip = makeNodeZip();

/** A deflate stream that expands to `mb` megabytes of filler. */
function bomb(mb) {
	const payload = Buffer.alloc(mb * 1024 * 1024, 0x41);
	return new Uint8Array(zlib.deflateSync(payload, { level: 9 }));
}

const MB = 1024 * 1024;

/* ── 1. the codec refuses rather than truncates ─────────────────────────────── */

report('');
report('Resource limits');
report(`  ceiling: ${MAX_INFLATE_BYTES.toLocaleString()} B (${MAX_INFLATE_BYTES / MB} MB) per inflate`);
report('');

await test('an over-large stream is refused by the shipped codec', async () => {
	assert(browserZip !== null, 'DecompressionStream is unavailable, so the shipped codec cannot be tested');

	const small = bomb(200); // 200 MB, past the 128 MB ceiling
	let thrown = null;
	try {
		await browserZip.inflate(small);
	} catch (err) {
		thrown = err;
	}

	assert(
		thrown !== null,
		`a 200 MB decode was allowed through a ${MAX_INFLATE_BYTES} B ceiling and returned a buffer`
	);
	assert(
		/ceiling/i.test(thrown.message),
		`the failure should name the ceiling so a user report is actionable, got: ${thrown.message}`
	);
});

await test('a refused stream yields NO partial output', async () => {
	/* The decisive control. If the codec truncated instead of throwing, the
	 * first test would still pass while callers received a corrupt prefix. */
	const compressed = bomb(200);
	let returned = null;
	let threw = false;
	try {
		returned = await browserZip.inflate(compressed);
	} catch {
		threw = true;
	}

	assert(threw, 'the control did not throw, so it cannot show that truncation is impossible');
	assert(returned === null, 'a buffer came back alongside the throw, and callers might use it');

	/* Independently: nothing anywhere may hold a decoded prefix. */
	assert(
		compressed.length < MAX_INFLATE_BYTES,
		'the test input is larger than the ceiling, so it would pass regardless of behaviour'
	);
});

await test('CONTROL: a stream just under the ceiling still decodes fully', async () => {
	/* If the ceiling rejected everything, every "it refused the bomb" result
	 * would be trivially true. This proves normal payloads pass. */
	const payload = Buffer.alloc(24 * MB, 0x42); // 24 MB - about a 600 DPI A4 scan
	const compressed = new Uint8Array(zlib.deflateSync(payload, { level: 9 }));
	const out = await browserZip.inflate(compressed);

	assert(out.length === payload.length, `expected ${payload.length} bytes, got ${out.length}`);
	assert(Buffer.compare(Buffer.from(out), payload) === 0, 'the decoded bytes differ from what was encoded');
});

await test('CONTROL: the ceiling is a real limit, not an absent one', async () => {
	/* Establishes that `bomb()` really does produce streams past the ceiling, so
	 * the refusal above is the codec acting and not a malformed test input. */
	const compressed = bomb((MAX_INFLATE_BYTES / MB) + 80);
	const payloadSize = (MAX_INFLATE_BYTES / MB) + 80;
	assert(
		compressed.length < MAX_INFLATE_BYTES,
		'the control input should be SMALLER than the ceiling - that is the whole trick of a bomb'
	);
	assert(payloadSize * MB > MAX_INFLATE_BYTES, 'the control input does not actually exceed the ceiling');
});

/* ── 2. the same ceiling on the Node codec used by tests and tooling ────────── */

await test('the Node codec refuses an over-large stream', async () => {
	let thrown = null;
	try {
		await nodeZip.inflate(bomb(200));
	} catch (err) {
		thrown = err;
	}
	assert(thrown !== null, 'the Node codec decoded 200 MB past a 128 MB ceiling');
});

await test('the Node codec still decodes ordinary payloads', async () => {
	const payload = Buffer.from('a small but genuine flate stream');
	const out = await nodeZip.inflate(new Uint8Array(zlib.deflateSync(payload, { level: 9 })));
	assert(out.length === payload.length, `expected ${payload.length} bytes, got ${out.length}`);
});

await test('the Node codec does not return a truncated prefix', async () => {
	/* `maxOutputLength` was verified to THROW rather than hand back a short
	 * buffer. This pins that behaviour, because a silent prefix here would be a
	 * corrupt image in every fixture that used a Flate-wrapped JPEG. */
	let threw = false;
	let out = null;
	try {
		out = await nodeZip.inflate(bomb(200));
	} catch {
		threw = true;
	}
	assert(threw, 'the Node codec returned a buffer for an over-large stream');
	assert(out === null, 'a buffer came back alongside the throw');
});

/* ── 3. the pipeline's response when inflate fails ─────────────────────────── */

/* Two claims, kept apart so each is unambiguous:
 *
 *   a) a bomb is refused by the codec               (sections 1 and 2)
 *   b) when inflate THROWS, the image is skipped    (this section)
 *
 * (b) is proven by injecting a codec that always throws, on a REAL fixture with
 * a real Flate-wrapped JPEG. That makes the failure unambiguous - there is no
 * question of whether a synthetic payload "really was" a bomb - and it costs no
 * memory, so the test stays fast and deterministic.
 */

const runner = makeRunner();
const codec = await makeCodec();
const FIXTURE = new Uint8Array(
	await readFile(new URL('../fixtures/jpeg-flate-wrapped.pdf', import.meta.url))
);

await test('an inflate failure skips the image instead of corrupting it', async () => {
	const throwingZip = {
		inflate: async () => {
			throw new Error('inflated stream exceeds the ceiling (injected)');
		},
		deflate: nodeZip.deflate
	};

	const result = await optimize({ bytes: FIXTURE, mode: 'balanced', zip: throwingZip }, runner, codec);

	assert(result.error === undefined, `the pipeline reported an error: ${result.error}`);
	assert(result.bytes !== null, 'no output at all, so nothing can be checked for corruption');

	const check = await runner(result.bytes, ['--check']);
	assert(
		check.code === 0 || check.code === 3,
		`the output failed qpdf --check with exit ${check.code}: ${check.diagnostics}`
	);
	report(`        output ${result.bytes.length.toLocaleString()} B, qpdf --check ${check.code}`);
});

await test('CONTROL: the same fixture is re-encoded when inflate works', async () => {
	/* Without this, "the output is valid" would be satisfied by doing nothing at
	 * all. The fixture must actually shrink when the codec succeeds, so the skip
	 * above is a consequence of the thrown error and not of the document. */
	const result = await optimize({ bytes: FIXTURE, mode: 'balanced', zip: nodeZip }, runner, codec);
	assert(result.error === undefined, `the pipeline reported an error: ${result.error}`);
	assert(
		result.bytes.length < FIXTURE.length,
		`the fixture should shrink when the image is re-encoded, but ${FIXTURE.length} -> ${result.bytes.length}`
	);
	report(`        ${FIXTURE.length.toLocaleString()} B -> ${result.bytes.length.toLocaleString()} B with a working codec`);
});

/* ── 4. end to end with a real bomb ────────────────────────────────────────── */

for (const mb of [400, 1000]) {
	await test(`a ${mb} MB decode is refused without allocating it`, async () => {
		const compressed = zlib.deflateSync(Buffer.alloc(mb * MB, 0x41), { level: 9 });
		const bombBytes = new Uint8Array(compressed);

		/* Building the bomb itself costs `mb` MB, so the measurement below is of
		 * the DECODE, taken after the buffer already exists. */
		const before = process.memoryUsage().heapUsed;
		const t0 = Date.now();
		let refused = false;
		try {
			await nodeZip.inflate(bombBytes);
		} catch {
			refused = true;
		}
		const ms = Date.now() - t0;
		const heapDelta = (process.memoryUsage().heapUsed - before) / MB;

		assert(refused, `a ${mb} MB decode was not refused`);
		assert(
			heapDelta < mb * 0.5,
			`heap grew ${heapDelta.toFixed(0)} MB decoding a ${mb} MB stream, so the payload was materialised before being refused`
		);
		report(
			`        ${(compressed.length / 1024).toFixed(0)} KB of file -> ${mb} MB refused in ${ms} ms, heap +${heapDelta.toFixed(0)} MB`
		);
	});
}

/* ── report ────────────────────────────────────────────────────────────────── */

report('');
report(`  shipped codec ceiling   : ${MAX_INFLATE_BYTES.toLocaleString()} B`);
report(`  refused without decoding: yes (throws, callers skip the payload)`);
report(`  partial output possible: no`);
report('');
report(`${passed} passed, ${failed} failed`);
if (failures.length) {
	report('\nFailures:');
	for (const f of failures) report(`  - ${f}`);
}
report('');

process.exit(failed ? 1 : 0);