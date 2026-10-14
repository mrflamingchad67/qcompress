/**
 * Why does a step of the pipeline produce nothing?
 *
 * Prints, for one fixture and one mode, exactly what each stage received and
 * returned. Used to diagnose the "found 0 images" and "dedupe never wins"
 * cases without guessing.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { findJpegImages, isReencodable } from '../src/lib/qpdf/images.ts';
import { dedupeStreams } from '../src/lib/qpdf/dedupe.ts';
import { bytesToLatin1 } from '../src/lib/qpdf/bytes.ts';
import { makeRunner, makeCodec } from './engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = (...a) => process.stdout.write(a.join(' ') + '\n');

const file = process.argv[2] ?? 'scan-300dpi-q80.pdf';
const quality = Number(process.argv[3] ?? 78);
const bytes = new Uint8Array(await readFile(path.join(here, 'fixtures', file)));
const runner = makeRunner();
const codec = await makeCodec();

out(`\n${file}: ${bytes.length} B, quality ${quality}\n`);

/* 1. flatten */
const FLATTEN = ['--no-warn', '--warning-exit-0', '--object-streams=disable', '--stream-data=preserve'];
out('flatten args: ' + JSON.stringify(FLATTEN));
const flat = await runner(bytes, FLATTEN);
out(`  code=${flat.code} out=${flat.out ? flat.out.length : 'null'}`);
out(`  diagnostics=${JSON.stringify(flat.diagnostics.slice(0, 300))}`);

if (!flat.out) process.exit(1);

const text = bytesToLatin1(flat.out);
const images = findJpegImages(text);
out(`  images found: ${images.length}, reencodable: ${images.filter(isReencodable).length}`);

/* 2. per-image codec */
for (const img of images.filter(isReencodable)) {
	try {
		const decoded = await codec.decode(img.data);
		const enc = await codec.encode(decoded, quality);
		out(`  img ${img.num}: ${img.width}x${img.height} ${img.length} B -> ${enc.length} B (${enc.length < img.length ? 'REPLACE' : 'skip, not smaller'})`);
	} catch (e) {
		out(`  img ${img.num}: THREW ${e?.message ?? e}`);
	}
}

/* 3. dedupe */
const ded = dedupeStreams(text);
out(`\ndedupe: inspected=${ded.objectsInspected} replaced=${ded.duplicatesReplaced} saved=${ded.bytesSaved} reason=${ded.reason ?? '-'}`);

if (ded.bytes) {
	const check = await runner(ded.bytes, ['--check']);
	out(`  dedupe output: ${ded.bytes.length} B, check exit ${check.code}`);
	out(`  diagnostics: ${JSON.stringify(check.diagnostics.slice(0, 300))}`);
}

out();