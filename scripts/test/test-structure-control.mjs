/**
 * Negative control for the semantic structure comparison.
 *
 * compareStructure exists to catch a document that passes `qpdf --check` while
 * losing something a reader would notice. For a long time it did not do that at
 * all: a duplicated tail left an early `return` above the per-page block, so
 * MediaBox, CropBox, /Rotate, annotation counts, annotation subtypes and link
 * URIs were never compared. The code read as though they were checked.
 *
 * Dead checks are worse than absent ones, because a reviewer concludes the
 * guarantee holds. So this proves the comparison reacts to each field it claims
 * to check, by corrupting a real fixture and requiring a diff.
 *
 * EVERY corruption is a same-length substitution. That keeps every byte offset
 * valid, so the xref table survives and the file remains a document qpdf
 * accepts. A control that only trips `qpdf --check` would be testing qpdf's
 * error handling rather than the comparison, so that is asserted first.
 *
 * Key renames (/Outlines -> /Xutlines) are used where a key must stop being
 * recognised. Removing a key outright would leave its value as a stray token
 * and produce an invalid document; renaming it leaves a well-formed pair under
 * an unknown key, which is legal PDF.
 *
 * Run: bun scripts/test/test-structure-control.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRunner } from '../lib/engine.mjs';
import { compareStructure } from '../lib/compare.mjs';
import { bytesToLatin1 } from '../../src/lib/qpdf/bytes.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

const runner = makeRunner();
const FLATTEN = ['--object-streams=disable', '--stream-data=preserve'];

const load = (n) => readFile(path.join(here, '..', 'fixtures', n)).then((b) => new Uint8Array(b));
const flat = async (bytes) => {
	const r = await runner(bytes, FLATTEN);
	return r.out ? bytesToLatin1(r.out) : null;
};

/** Same-length substitution, so every byte offset and the xref stay valid. */
function swap(text, find, replace) {
	if (find.length !== replace.length) {
		throw new Error(`"${find}" -> "${replace}" changes length, which would break the xref`);
	}
	const at = text.indexOf(find);
	if (at === -1) throw new Error(`could not find ${JSON.stringify(find)}`);
	const out = text.slice(0, at) + replace + text.slice(at + find.length);
	if (out === text) throw new Error('the replacement changed nothing');
	return out;
}

let passed = 0;
let failed = 0;
const failures = [];

async function control(name, fixture, find, replace, expectField) {
	try {
		const original = await flat(await load(fixture));
		if (original === null) throw new Error('fixture would not flatten');

		const damagedText = swap(original, find, replace);
		const damaged = new Uint8Array(Buffer.from(damagedText, 'latin1'));

		const after = await flat(damaged);
		if (after === null) throw new Error('the corrupted copy would not flatten');

		// The control is only meaningful if the corrupted document is still one
		// qpdf accepts. Otherwise it is testing qpdf's error handling.
		const chk = await runner(damaged, ['--check']);
		if (chk.code !== 0 && chk.code !== 3) {
			failed++;
			failures.push(`${name}: corrupted file is not a valid PDF (qpdf exit ${chk.code}) - proves nothing`);
			report(`  FAIL  ${name}   (qpdf exit ${chk.code}, invalid)`);
			return;
		}

		const r = compareStructure(original, after);
		const got = r.diffs.map((d) => d.field);

		if (!r.diffs.length) {
			failed++;
			failures.push(`${name}: comparison reported no differences at all`);
			report(`  FAIL  ${name}   (no diffs reported)`);
			return;
		}
		if (!got.some((f) => f === expectField || f.startsWith(expectField))) {
			failed++;
			failures.push(`${name}: expected ${expectField}, got ${got.join(', ')}`);
			report(`  FAIL  ${name}   (expected ${expectField}, got ${got.join(', ')})`);
			return;
		}

		passed++;
		report(`  ok    ${name.padEnd(42)} -> ${expectField}`);
	} catch (err) {
		failed++;
		failures.push(`${name}: ${err.message}`);
		report(`  FAIL  ${name.padEnd(42)}  ${err.message}`);
	}
}

report('');
report('Semantic comparison negative control - can compareStructure actually fail?');
report('');
report('Same-length corruption of a real fixture; the file must stay a valid PDF.');
report('');

/* ── annotations ───────────────────────────────────────────────────────────── */

await control('a renamed /Annots key is detected', 'links.pdf', '/Annots', '/Xnnots', 'page[1].annotCount');
await control('a changed link target is detected', 'links.pdf', 'https://a.example', 'https://z.example', 'page[1].linkUris');
await control('a changed annotation subtype is detected', 'annotations.pdf', '/Subtype /Square', '/Subtype /Circle', 'page[1].annotSubtypes');

/* ── page geometry ─────────────────────────────────────────────────────────── */

await control('a changed MediaBox is detected', 'annotations.pdf', '/MediaBox [ 0 0 612 792 ]', '/MediaBox [ 0 0 612 793 ]', 'page[1].mediaBox');
await control('a changed CropBox is detected', 'cropbox.pdf', '/CropBox [ 10 20 500 700 ]', '/CropBox [ 11 20 500 700 ]', 'page[1].cropBox');
await control('a changed /Rotate is detected', 'rotated-pages.pdf', '/Rotate 90', '/Rotate 91', 'page[1].rotate');
await control('a changed later-page MediaBox is detected', 'mixed-page-sizes.pdf', '/MediaBox [ 0 0 842 595 ]', '/MediaBox [ 0 0 842 596 ]', 'page[2].mediaBox');

/* ── document features ─────────────────────────────────────────────────────── */

await control('an altered outline title is detected', 'outlines.pdf', '/Title (Chapter One)', '/Title (Chapter Ono)', 'outlineTitles');
await control('a renamed /Outlines key is detected', 'outlines.pdf', '/Outlines', '/Xutlines', 'hasOutlines');
await control('a renamed form field is detected', 'acroform.pdf', '/T (fullName)', '/T (fullNamf)', 'formFields');
await control('a renamed /AcroForm key is detected', 'acroform.pdf', '/AcroForm', '/XcroForm', 'hasAcroForm');

/* ── the comparison must also be quiet when nothing is wrong ───────────────── */

try {
	const a = await flat(await load('outlines.pdf'));
	const b = await flat(await load('outlines.pdf'));
	const r = compareStructure(a, b);
	if (r.diffs.length === 0) {
		passed++;
		report(`  ok    ${'an unmodified fixture reports no differences'.padEnd(42)}`);
	} else {
		failed++;
		failures.push(`an unmodified fixture reported: ${r.diffs.map((d) => d.field).join(', ')}`);
		report(`  FAIL  an unmodified fixture reported: ${r.diffs.map((d) => d.field).join(', ')}`);
	}
} catch (err) {
	failed++;
	failures.push(`self-comparison threw: ${err.message}`);
	report(`  FAIL  self-comparison threw: ${err.message}`);
}

report('');
report(`${passed} controls behaved correctly, ${failed} did not`);
if (failures.length) {
	report('');
	for (const f of failures) report(`  - ${f}`);
}
report('');

process.exit(failed ? 1 : 0);