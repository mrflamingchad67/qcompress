/**
 * `applyReplacements` splices every image edit in one pass.
 *
 * WHY THIS SUITE
 *
 * The function used to rebuild the whole document string once per replaced
 * image:
 *
 *     out = out.slice(0, dictStart) + dict + ... + out.slice(...)
 *
 * Measured on the 32-page book: 33 images, a 2.9 MB document carried as a
 * 5.8 MB JS string (PDF text is UTF-16), so about 191 MB of transient copying.
 * It now collects the edits and splices once. That is a large behavioural risk
 * for a pure-performance change, so the invariants the old implementation
 * satisfied are pinned here.
 *
 * The strongest of them is INCREMENTAL CONSISTENCY: replacing one image and
 * re-reading the document must give the same bytes as replacing them all at
 * once. A single-pass rewrite that mis-orders edits, or that reads offsets from
 * a document it has already edited, fails that immediately - and a byte-count
 * check would not notice.
 *
 * Run: bun scripts/test/test-image-replacements.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { findJpegImages, isReencodable, applyReplacements } from '../../src/lib/qpdf/images.ts';
import { bytesToLatin1 } from '../../src/lib/qpdf/bytes.ts';
import { makeRunner } from '../lib/engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const report = (...a) => process.stdout.write(a.join(' ') + '\n');
const runner = makeRunner();
const FLATTEN = ['--no-warn', '--warning-exit-0', '--object-streams=disable', '--stream-data=preserve'];

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

/** A replacement of a chosen size, so offsets shift by a controlled amount. */
function replacementFor(img, fraction, { resize = true } = {}) {
	const n = Math.max(1, Math.floor(img.length * fraction));
	return {
		num: img.num,
		jpeg: new Uint8Array(n).fill(0x41 + (img.num % 20)),
		width: resize ? Math.max(1, Math.floor(img.width * 0.8)) : img.width,
		height: resize ? Math.max(1, Math.floor(img.height * 0.8)) : img.height,
		originalBytes: img.length
	};
}

/* ── 1. incremental consistency: one at a time equals all at once ──────────── */

report('');
report('Image replacement');
report('  replacing one image at a time must equal replacing them together');
report('');

const fixtureDir = path.join(here, '..', 'fixtures');
const names = (await readdir(fixtureDir)).filter((f) => f.endsWith('.pdf'));

let multiImageFixtures = 0;

for (const name of names) {
	const bytes = new Uint8Array(await readFile(path.join(fixtureDir, name)));
	const out = (await runner(bytes, FLATTEN)).out;
	if (!out) continue;
	const flat = bytesToLatin1(out);

	const images = findJpegImages(flat);
	const targets = images.filter(isReencodable);
	if (targets.length < 2) continue;
	multiImageFixtures++;

	await test(`${name}: batch replacement equals incremental replacement`, () => {
		const planned = targets.map((img) => ({ img, rep: replacementFor(img, 0.6) }));

		/* All at once, on the original document. */
		const batchMap = new Map(planned.map(({ img, rep }) => [img.num, rep]));
		const batch = applyReplacements(flat, images, batchMap);
		assert(batch !== null, 'the batch pass applied nothing');

		/* One at a time, re-reading the document between steps - which is what a
		 * caller would get from the old per-image rebuild, and what any correct
		 * single-pass rewrite has to match. */
		let sequential = flat;
		let applied = 0;
		for (const { img, rep } of planned) {
			const reImages = findJpegImages(sequential);
			const reImg = reImages.find((i) => i.num === img.num);
			if (!reImg) continue;
			const step = applyReplacements(sequential, reImages, new Map([[img.num, rep]]));
			if (step === null) continue;
			sequential = step.text;
			applied++;
		}

		assert(applied === batch.applied, `applied ${batch.applied} in one pass but ${applied} incrementally`);
		assert(
			batch.bytesSaved === planned.reduce((t, { img, rep }) => t + Math.max(0, img.length - rep.jpeg.length), 0),
			`bytesSaved ${batch.bytesSaved} does not match the sum of individual savings`
		);

		/* The decisive comparison. If a batched pass edited the document before
		 * reading the remaining offsets, the two diverge here and nowhere else. */
		if (batch.text !== sequential) {
			let i = 0;
			while (i < batch.text.length && i < sequential.length && batch.text[i] === sequential[i]) i++;
			throw new Error(
				`batched and incremental replacement diverge at byte ${i} ` +
					`(lengths ${batch.text.length} vs ${sequential.length})`
			);
		}
	});
}

/* ── 2. the structural invariants the old pass relied on ───────────────────── */

await test('a replacement only applies when the new payload is smaller', () => {
	const doc =
		'1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
		'2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
		'3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
		'4 0 obj\n<< /Length 10 >>\nstream\n0123456789\nendstream\nendobj\n' +
		'xref\n0 5\n0000000000 65535 f \ntrailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n';
	const images = [{ num: 4, dictStart: doc.indexOf('<<', doc.indexOf('4 0 obj')), dataStart: doc.indexOf('0123456789'), length: 10, width: 100, height: 100 }];
	const dictStart = doc.indexOf('<<', doc.indexOf('4 0 obj'));
	images[0].dictStart = dictStart;

	const bigger = applyReplacements(doc, images, new Map([[4, { num: 4, jpeg: new Uint8Array(50), width: 100, height: 100, originalBytes: 10 }]]));
	assert(bigger === null, `a payload 5x larger was applied instead of skipped (${bigger?.applied} applied)`);

	const smaller = applyReplacements(doc, images, new Map([[4, { num: 4, jpeg: new Uint8Array(4), width: 80, height: 80, originalBytes: 10 }]]));
	assert(smaller !== null, 'a smaller payload was refused');
	assert(smaller.applied === 1, `expected 1 applied, got ${smaller.applied}`);
	assert(smaller.bytesSaved === 6, `expected 6 bytes saved, got ${smaller.bytesSaved}`);
});

await test('/Length in the output matches the new payload exactly', () => {
	/* The original payload must be LARGER than the replacement, or the
	 * replacement is correctly skipped for making the file worse - which is what
	 * this suite's first test pins separately. */
	const original = '0123456789'.repeat(20); // 200 bytes
	const doc =
		'1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
		'2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
		'3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
		`4 0 obj\n<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /Length ${original.length} >>\nstream\n${original}\nendstream\nendobj\n` +
		'xref\n0 5\n0000000000 65535 f \ntrailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n';
	const dictStart = doc.indexOf('<<', doc.indexOf('4 0 obj'));
	const images = [{ num: 4, dictStart, dataStart: doc.indexOf(original), length: original.length, width: 100, height: 100 }];

	const payload = new Uint8Array(37).fill(0x5a);
	const r = applyReplacements(
		doc,
		images,
		new Map([[4, { num: 4, jpeg: payload, width: 64, height: 48, originalBytes: original.length }]])
	);
	assert(r !== null, 'nothing applied');

	const declared = parseInt(/\/Length\s+(\d+)/.exec(r.text)?.[1] ?? '0', 10);
	assert(declared === 37, `/Length says ${declared} but the payload is ${payload.length} bytes`);
	assert(/\/Width\s+64/.test(r.text), '/Width was not updated');
	assert(/\/Height\s+48/.test(r.text), '/Height was not updated');
	assert(!r.text.includes(original), 'the old payload survived in the output');

	/* The declared length must describe what is actually there, or the output is
	 * a corrupt stream - the one outcome this must never produce. */
	const dataAt = r.text.indexOf('stream\n', dictStart) + 'stream\n'.length;
	const endstream = r.text.indexOf('\nendstream', dataAt);
	assert(endstream - dataAt === declared, `payload is ${endstream - dataAt} bytes but /Length declares ${declared}`);
});

await test('text outside every edit is preserved byte for byte', () => {
	const doc =
		'1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
		'2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
		'3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
		'4 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /Length 4 >>\nstream\nABCD\nendstream\nendobj\n' +
		'xref\n0 5\n0000000000 65535 f \ntrailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n';
	const dictStart = doc.indexOf('<<', doc.indexOf('4 0 obj'));
	const images = [{ num: 4, dictStart, dataStart: doc.indexOf('ABCD'), length: 4, width: 8, height: 8 }];

	const r = applyReplacements(doc, images, new Map([[4, { num: 4, jpeg: new Uint8Array(2), width: 8, height: 8, originalBytes: 4 }]]));
	assert(r !== null, 'nothing applied');

	const beforeTail = doc.slice(doc.indexOf('\nendstream'));
	const afterTail = r.text.slice(r.text.indexOf('\nendstream'));
	assert(beforeTail === afterTail, 'the document tail after the edit was altered');
	assert(r.text.startsWith(doc.slice(0, dictStart)), 'the document head before the edit was altered');
});

/* ── 3. controls ───────────────────────────────────────────────────────────── */

await test('CONTROL: a corrupted edit set is detected, not silently accepted', () => {
	const doc =
		'1 0 obj\n<< /Type /Catalog >>\nendobj\n' +
		'2 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /Length 4 >>\nstream\nABCD\nendstream\nendobj\n' +
		'xref\n0 3\ntrailer\n<< /Size 3 >>\n%%EOF\n';
	const dictStart = doc.indexOf('<<', doc.indexOf('2 0 obj'));

	/* An image whose dictStart points INSIDE the payload is malformed input.
	 * It must be skipped, never produce a document. */
	const images = [{ num: 2, dictStart, dataStart: doc.indexOf('ABCD'), length: 4, width: 8, height: 8 }];
	images[0].dictStart = doc.indexOf('ABCD');
	const r = applyReplacements(doc, images, new Map([[2, { num: 2, jpeg: new Uint8Array(2), width: 8, height: 8, originalBytes: 4 }]]));
	assert(r === null, 'an edit starting inside the payload was applied instead of skipped');
});

await test('CONTROL: no replacements means no output at all', () => {
	const doc = '1 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /Length 4 >>\nstream\nABCD\nendstream\nendobj\n';
	const images = [{ num: 1, dictStart: doc.indexOf('<<'), dataStart: doc.indexOf('ABCD'), length: 4, width: 8, height: 8 }];
	assert(applyReplacements(doc, images, new Map()) === null, 'an empty replacement set produced a document');
});

void zlib;

report('');
report(`  fixtures with 2+ images : ${multiImageFixtures}`);
report(`${passed} passed, ${failed} failed`);
if (failures.length) {
	report('\nFailures:');
	for (const f of failures) report(`  - ${f}`);
}
report('');

process.exit(failed ? 1 : 0);