/**
 * Why did a document barely shrink?
 *
 * Explains, image by image, whether the engine could touch it and if not why.
 * The UI currently reports "unchanged as-is", which is honest but useless when
 * a real document comes back at 1%; this prints the actual reason.
 *
 * Usage: bun scripts/tools/explain.mjs <file.pdf> [mode]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { optimize } from '../../src/lib/qpdf/pipeline.ts';
import { findJpegImages, isReencodable, skipReason } from '../../src/lib/qpdf/images.ts';
import { bytesToLatin1 } from '../../src/lib/qpdf/bytes.ts';
import { makeRunner, makeCodec, makeZip } from '../lib/engine.mjs';

const out = (...a) => process.stdout.write(a.join(' ') + '\n');

const file = process.argv[2];
if (!file) {
	out('\nusage: bun scripts/tools/explain.mjs <file.pdf> [lossless|balanced|maximum]\n');
	process.exit(2);
}
const mode = process.argv[3] ?? 'maximum';

const runner = makeRunner();
const codec = await makeCodec();
const zip = makeZip();

const bytes = new Uint8Array(await readFile(file));
out(`\n${path.basename(file)}  ${bytes.length} B  mode=${mode}\n`);

const check = await runner(bytes, ['--check']);
out(`  qpdf --check exit = ${check.code}`);

const flat = await runner(bytes, ['--object-streams=disable', '--stream-data=preserve']);
if (!flat.out) {
	out('  qpdf could not flatten this file; no further analysis is possible.\n');
	process.exit(1);
}
const text = bytesToLatin1(flat.out);

const all = findJpegImages(text);
const reencodable = all.filter(isReencodable);

out(`  DCTDecode images = ${all.length}`);
out(`  re-encodable     = ${reencodable.length}`);

if (all.length) {
	const totalImageBytes = all.reduce((a, i) => a + i.length, 0);
	const eligibleBytes = reencodable.reduce((a, i) => a + i.length, 0);
	out(`  image payload    = ${totalImageBytes} B (${((totalImageBytes / bytes.length) * 100).toFixed(1)}% of the file)`);
	out(`  eligible payload = ${eligibleBytes} B (${((eligibleBytes / bytes.length) * 100).toFixed(1)}% of the file)`);
}

/* Why each one was skipped, grouped so the pattern is obvious. */
const reasons = new Map();
for (const img of all) {
	const why = skipReason(img) ?? '(eligible)';
	reasons.set(why, (reasons.get(why) ?? 0) + 1);
}
if (reasons.size) {
	out('\n  skip reasons:');
	for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
		out(`    ${String(n).padStart(3)} x ${why}`);
	}
}

out('\n  encoding breakdown:');
const enc = new Map();
for (const i of all) {
	const k = `${i.encoding ?? 'other'} / ${i.colorspace || 'unknown'} / ${i.bitsPerComponent}bpc${i.hasSMask ? ' / smask' : ''}`;
	enc.set(k, (enc.get(k) ?? 0) + 1);
}
for (const [k, n] of [...enc].sort((a, b) => b[1] - a[1])) out(`    ${String(n).padStart(3)} x ${k}`);

out('\n  largest images:');
for (const i of [...all].sort((a, b) => b.length - a.length).slice(0, 6)) {
	out(
		`    obj ${String(i.num).padStart(4)} ${String(i.width + 'x' + i.height).padStart(11)}  ` +
			`${String(i.length).padStart(9)} B  ${i.colorspace || '?'} ${i.encoding ?? '?'}` +
			`${skipReason(i) ? '  SKIP: ' + skipReason(i) : ''}`
	);
}

out('\n  running the orchestrator…');
const t0 = performance.now();
const res = await optimize({ bytes, mode, zip }, runner, codec);
out(
	`    ${res.originalBytes} -> ${res.bytes.length} B  (${res.percent.toFixed(1)}% smaller)  ` +
		`strategy=${res.strategy} lossy=${res.lossy} fallback=${res.fallback}`
);
out(`    images: ${res.imagesProcessed} examined, ${res.imagesReplaced} re-encoded, ${res.durationMs ?? Math.round(performance.now() - t0)} ms`);
for (const c of res.candidates) {
	out(`      ${c.valid ? 'valid  ' : 'rejected'} ${c.name.padEnd(22)} ${String(c.bytes).padStart(10)} B${c.rejected ? '  :: ' + c.rejected : ''}`);
}
out('');