/**
 * P2 - performance profiling harness. MEASURE FIRST.
 *
 * This does not change behaviour. It runs the real pipeline and reports where
 * the time goes, per candidate, so any later optimisation is aimed at measured
 * cost rather than guesswork.
 *
 * Why this shape: the orchestrator tries up to four image passes for Maximum
 * (q78 and q55, each as image-aware and dedupe+image), and Maximum already
 * guarantees it never returns something larger than Balanced. If most of that
 * work is discarded, the win is in not doing it - but that is a hypothesis, and
 * this is what settles it.
 *
 * Usage: bun scripts/tools/profile.mjs <file.pdf> [mode] [--scale <runs>]
 *
 * Lives in scripts/tools/ so it stays with the other measurement tools.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { optimize, MODE_ATTEMPTS, MODE_SETTINGS } from '../../src/lib/qpdf/pipeline.ts';
import { makeRunner, makeCodec, makeZip } from '../lib/engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const mode = argv[argv.indexOf(file) + 1] && !argv[argv.indexOf(file) + 1].startsWith('--') ? argv[argv.indexOf(file) + 1] : 'maximum';
const scaleIdx = argv.indexOf('--scale');
const RUNS = scaleIdx !== -1 ? Number(argv[scaleIdx + 1]) : 1;

if (!file) {
	log('');
	log('usage: bun scripts/tools/profile.mjs <file.pdf> [lossless|balanced|maximum] [--scale <runs>]');
	log('');
	process.exit(2);
}

const bytes = new Uint8Array(await readFile(file));
const runner = makeRunner();
const codec = await makeCodec();
const zip = makeZip();

const settings = MODE_SETTINGS[mode];
const attempts = MODE_ATTEMPTS[mode];

log('');
log(`profile: ${path.basename(file)}`);
log(`  size    : ${bytes.length} B (${(bytes.length / 1048576).toFixed(2)} MB)`);
log(`  mode    : ${mode}`);
if (settings) log(`  settings: quality ${settings.quality}, maxLongEdge ${settings.maxLongEdge || 'none'}`);
log(`  passes  : ${attempts.length} quality setting(s) x { image-aware, dedupe+image }`);
log(`  runs    : ${RUNS}`);

/* Count the work up front, so the numbers can be read against it. */
const flat = await runner(bytes, ['--object-streams=disable', '--stream-data=preserve']);
if (flat.out) {
	const text = Buffer.from(flat.out).toString('latin1');
	const images = (text.match(/\/Subtype\s*\/Image/g) ?? []).length;
	// DCTDecode may appear alone or inside a filter array
	// (`/Filter [/FlateDecode /DCTDecode]`), so match the token, not the phrase.
	const dct = (text.match(/\/DCTDecode/g) ?? []).length;
	log(`  images  : ${images} total, ${dct} carrying DCTDecode`);
	log('');
}

/* Time each run, and report the spread. Compression time is user-visible
 * latency, so a single sample would be a fabricated statistic. */
const timings = [];
const lastResult = { current: null };

for (let i = 0; i < RUNS; i++) {
	const t0 = Date.now();
	const res = await optimize({ bytes, mode, zip }, runner, codec);
	const ms = Date.now() - t0;
	timings.push(ms);
	lastResult.current = res;

	log(`  run ${i + 1}: ${ms} ms  ->  ${res.bytes.length} B ` +
		`(${(((bytes.length - res.bytes.length) / bytes.length) * 100).toFixed(2)}% smaller)  ` +
		`strategy ${res.strategy}`);
	log(`          images ${res.imagesReplaced}/${res.imagesProcessed} re-encoded` +
		(res.imageSkips?.length ? `, skipped ${JSON.stringify(res.imageSkips)}` : ''));
}

/* Per-candidate breakdown from the final run: where the time actually went. */
const finalRes = lastResult.current;
if (finalRes?.candidates?.length) {
	log('');
	log('  candidate breakdown (final run):');
	log(`  ${'candidate'.padEnd(26)} ${'ms'.padStart(7)} ${'%'.padStart(6)} ${'bytes'.padStart(10)}  outcome`);
	const total = finalRes.candidates.reduce((a, c) => a + (c.ms ?? 0), 0);
	for (const c of finalRes.candidates) {
		const pct = total ? (100 * (c.ms ?? 0)) / total : 0;
		const outcome = !c.valid ? `REJECTED (${c.rejected ?? 'invalid'})` : c.name === finalRes.strategy ? '*** SELECTED' : 'valid';
		log(`  ${c.name.padEnd(26)} ${String(c.ms ?? 0).padStart(7)} ${pct.toFixed(1).padStart(5)}% ${String(c.bytes).padStart(10)}  ${outcome}`);
	}
	log(`  ${'sum of candidates'.padEnd(26)} ${String(total).padStart(7)}        (run took ${timings.at(-1)} ms)`);
}

if (timings.length > 1) {
	const min = Math.min(...timings);
	const max = Math.max(...timings);
	const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
	log('');
	log(`  min ${min} ms   mean ${mean.toFixed(0)} ms   max ${max} ms   spread ${(((max - min) / mean) * 100).toFixed(1)}%`);
	log('  (informal: single machine, single document, no concurrency)');
}
log('');