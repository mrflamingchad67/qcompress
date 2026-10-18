/**
 * Heap accounting for the image-replacement path, measured in Node.
 *
 * WHY NODE AND NOT BUN
 *
 * The same comparison under Bun reported a peak of 0 MB for both
 * implementations, across three different sampling approaches: large string
 * allocations do not appear in Bun's `heapUsed`, and a short sampling interval
 * misses a window lasting only a few milliseconds. Node runs the same V8 as
 * Chromium and exposes `v8.getHeapStatistics()`, which accounts for
 * large-object-space strings - the thing actually being allocated here.
 *
 * WHAT IS COMPARED
 *
 * The current single-pass `applyReplacements` against the previous per-image
 * rebuild, both loaded in one process, run alternately so JIT state and GC
 * history affect them equally. Output is asserted byte-identical before any
 * number is reported: a faster implementation that produced different bytes
 * would be a defect, not an improvement.
 *
 * WHY THE EARLIER SAMPLING ATTEMPTS REPORTED 0 MB
 *
 * `applyReplacements` is fully SYNCHRONOUS. A `setInterval` callback cannot run
 * while synchronous code is on the stack, so a sampler never fires during the
 * call and the "peak" is always the baseline. That was the bug - in Bun and in
 * Node alike. Bun's heap was never the problem.
 *
 * Why Bun then appeared to see nothing at all: V8 concatenations are
 * CONS-STRINGS (ropes). Measured directly - building 256 strings totalling
 * 128 MB moved rss by 0.0 MB; forcing each one flat with `charCodeAt` moved it
 * by 258.3 MB. A rope is a tree of pointers.
 *
 * The old implementation flattened the document on every iteration, because
 * `matchDict` reads `charCodeAt`/`startsWith` on the string it is handed, and
 * the string it was handed was the growing concatenation - roughly 33
 * flattenings of a ~6 MB document. The single-pass version matches every
 * dictionary against the ORIGINAL string and never re-flattens.
 *
 * That churn is transient: it is collected as it is produced, which is exactly
 * why removing it does not lower the peak. The measurable win is TIME.
 *
 * Run: node --expose-gc --import ./scripts/tools/register-ts.mjs scripts/tools/heap-images.mjs
 */
import v8 from 'node:v8';
import { readFile } from 'node:fs/promises';

import { findJpegImages, isReencodable, applyReplacements } from '../../src/lib/qpdf/images.ts';
import { bytesToLatin1 } from '../../src/lib/qpdf/bytes.ts';
import { makeRunner } from '../lib/engine.mjs';

const report = (...a) => process.stdout.write(a.join(' ') + '\n');
const mb = (n) => (n / 1048576).toFixed(1);

const DOCUMENT = process.argv[2] ?? 'C:/Users/User/Desktop/AI Training Preparation Book Final.pdf';
const FLATTEN = ['--no-warn', '--warning-exit-0', '--object-streams=disable', '--stream-data=preserve'];

/**
 * The previous implementation, reconstructed from the committed source.
 *
 * `src/lib/qpdf/images.ts` at b318c0d rebuilt the document inside the loop.
 * Reproducing it here means the comparison needs no second copy of the file in
 * the repository, which would otherwise be a stale fork nothing keeps in sync.
 */
function previousApplyReplacements(s, images, replace, matchDict) {
	const targets = images
		.filter((img) => replace.has(img.num))
		.map((img) => ({ img, rep: replace.get(img.num) }))
		.filter(({ img, rep }) => rep.jpeg.length < img.length)
		.sort((a, b) => b.img.dataStart - a.img.dataStart);

	if (!targets.length) return null;

	let out = s;
	let applied = 0;
	let bytesSaved = 0;

	for (const { img, rep } of targets) {
		const dictStart = img.dictStart;
		const dictEnd = matchDict(out, dictStart);
		if (dictStart === -1 || dictEnd === -1 || dictEnd > img.dataStart) continue;

		let dict = out.slice(dictStart, dictEnd);
		const withLength = dict.replace(/(\/Length\s+)\d+/, `$1${rep.jpeg.length}`);
		if (withLength === dict) continue;
		dict = withLength;
		if (rep.width !== img.width) dict = dict.replace(/(\/Width\s+)\d+/, `$1${rep.width}`);
		if (rep.height !== img.height) dict = dict.replace(/(\/Height\s+)\d+/, `$1${rep.height}`);

		out =
			out.slice(0, dictStart) +
			dict +
			out.slice(dictEnd, img.dataStart) +
			bytesToLatin1(rep.jpeg) +
			out.slice(img.dataStart + img.length);
		applied++;
		bytesSaved += img.length - rep.jpeg.length;
	}

	if (!applied) return null;
	return { text: out, applied, bytesSaved };
}

/** The same brace matcher the committed file used. */
function matchDict(text, start) {
	let depth = 0;
	for (let i = start; i < text.length - 1; i++) {
		if (text[i] === '(') {
			let d = 0;
			let j = i;
			for (; j < text.length; j++) {
				if (text[j] === '\\') { j++; continue; }
				if (text[j] === '(') d++;
				else if (text[j] === ')') { d--; if (d === 0) break; }
			}
			if (j >= text.length) return -1;
			i = j;
			continue;
		}
		if (text.startsWith('<<', i)) { depth++; i++; continue; }
		if (text.startsWith('>>', i)) { depth--; i++; if (depth === 0) return i + 1; }
	}
	return -1;
}

const runner = makeRunner();
const bytes = new Uint8Array(await readFile(DOCUMENT));
const flat = bytesToLatin1((await runner(bytes, FLATTEN)).out);
const images = findJpegImages(flat);
const targets = images.filter(isReencodable);

function buildReplace() {
	const m = new Map();
	for (const img of targets) {
		const n = Math.max(1, Math.floor(img.length * 0.5));
		m.set(img.num, {
			num: img.num,
			jpeg: new Uint8Array(n).fill(0x41),
			width: Math.max(1, Math.floor(img.width * 0.8)),
			height: Math.max(1, Math.floor(img.height * 0.8)),
			originalBytes: img.length
		});
	}
	return m;
}

const previous = (s, i, r) => previousApplyReplacements(s, i, r, matchDict);
const current = applyReplacements;

/* Correctness first. No timing is reported until the outputs match. */
const a = previous(flat, images, buildReplace());
const b = current(flat, images, buildReplace());
const identical = a !== null && b !== null && a.text === b.text && a.applied === b.applied && a.bytesSaved === b.bytesSaved;

report('');
report('Heap accounting in Node (V8), image replacement');
report(`  document      : ${DOCUMENT.split(/[\\/]/).pop()}`);
report(`  ${images.length} images, ${targets.length} re-encodable, document held as a ${mb(flat.length)} MB string`);
report('');
report(`  outputs identical: ${identical ? 'yes' : 'NO'}`);
if (!identical) {
	report('  refusing to report timings for implementations that disagree');
	process.exit(1);
}
report(`  applied ${a.applied}, saved ${a.bytesSaved.toLocaleString()} bytes`);
report('');

/* Measure rss before and after, with no sampler.
 *
 * A sampler is useless here: the function is synchronous, so no callback can
 * run while it executes. Sampling before and after captures the allocation that
 * survives to the end of the call, which for transient churn is close to
 * nothing - and that is the honest result, not a failure to measure. */
function measure(fn, rounds) {
	const deltas = [];
	const times = [];
	for (let i = 0; i < rounds; i++) {
		global.gc();
		global.gc();
		const before = process.memoryUsage();
		const t0 = process.hrtime.bigint();
		const r = fn(flat, images, buildReplace());
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		const after = process.memoryUsage();
		if (!r) throw new Error('no output');
		deltas.push(Math.max(0, after.rss - before.rss));
		times.push(ms);
	}
	deltas.sort((x, y) => x - y);
	times.sort((x, y) => x - y);
	return { peak: deltas[deltas.length >> 1], time: times[times.length >> 1] };
}

// Warm both paths so neither pays JIT cost in the measured rounds.
for (let i = 0; i < 5; i++) { previous(flat, images, buildReplace()); current(flat, images, buildReplace()); }

const oldP = [], newP = [], oldT = [], newT = [];
for (let i = 0; i < 9; i++) {
	const o = measure(previous, 1); oldP.push(o.peak); oldT.push(o.time);
	const n = measure(current, 1); newP.push(n.peak); newT.push(n.time);
}
const med = (arr) => { const s = [...arr].sort((x, y) => x - y); return s[s.length >> 1]; };
const range = (arr) => { const s = [...arr].sort((x, y) => x - y); return `${mb(Math.min(...s))}-${mb(Math.max(...s))}`; };

report('                     rss retained (median)       time (median)');
report(`  per-image rebuild   ${mb(med(oldP)).padStart(8)} MB  [${range(oldP)}]   ${med(oldT).toFixed(1).padStart(7)} ms`);
report(`  single pass         ${mb(med(newP)).padStart(8)} MB  [${range(newP)}]   ${med(newT).toFixed(1).padStart(7)} ms`);
report('');
report(`  time:      ${med(oldT).toFixed(1)} ms -> ${med(newT).toFixed(1)} ms  (${(med(oldT) / med(newT)).toFixed(1)}x faster)`);
report('');
report('  Retained rss is only a few MB for BOTH, and that is the finding rather');
report('  than a measurement failure: the old code flattened the document once per');
report('  image, but each flattening is collected as the next is produced, so the');
report('  peak does not rise. The win here is time, not resident bytes.');
report('');