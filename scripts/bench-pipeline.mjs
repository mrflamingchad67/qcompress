/**
 * Full-pipeline benchmark: runs the real orchestrator (not a single qpdf
 * invocation) over every fixture in every mode, and reports only what actually
 * happened.
 *
 * For each fixture and mode it prints what the orchestrator chose, how many
 * images it touched, whether the output validated, and how long it took. Every
 * candidate the orchestrator considered is listed too, so a run that gains
 * nothing can be seen rather than inferred.
 *
 * Usage: bun scripts/bench-pipeline.mjs [mode ...] [fixture ...]
 */
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { optimize, MODE_SETTINGS } from '../src/lib/qpdf/pipeline.ts';
import { makeRunner, makeCodec } from './engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

/* ── fixtures ─────────────────────────────────────────────────────────────── */

async function loadFixtures() {
	const dir = path.join(here, 'fixtures');
	const files = (await readdir(dir)).filter((f) => f.endsWith('.pdf')).sort();
	return Promise.all(
		files.map(async (f) => ({ name: f, bytes: new Uint8Array(await readFile(path.join(dir, f))) }))
	);
}

/* ── input ────────────────────────────────────────────────────────────────── */

const all = await loadFixtures();
const argv = process.argv.slice(2);
const MODES = ['lossless', 'balanced', 'maximum'];
const modes = argv.filter((a) => MODES.includes(a));
const only = argv.filter((a) => !MODES.includes(a));
const useModes = modes.length ? modes : MODES;
const list = only.length ? all.filter((f) => only.includes(f.name)) : all;

const runner = makeRunner();
const codec = await makeCodec();

/* ── run ──────────────────────────────────────────────────────────────────── */

report('');
report('Pipeline benchmark - the real orchestrator, not a single qpdf call');
report(`modes: ${useModes.join(', ')}   fixtures: ${list.length}`);
report(`lossless never generates lossy candidates: ${MODE_SETTINGS.lossless === null ? 'yes' : 'NO'}`);
report('');

const totals = new Map();

for (const mode of useModes) {
	report(`── ${mode} ${MODE_SETTINGS[mode] ? `quality=${MODE_SETTINGS[mode].quality} maxLongEdge=${MODE_SETTINGS[mode].maxLongEdge || 'none'}` : '(structure only, nothing is degraded)'}`);
	report(
		`${'fixture'.padEnd(26)} ${'in'.padStart(9)} ${'out'.padStart(9)} ${'saved'.padStart(9)} ` +
			`${'%'.padStart(7)} ${'ms'.padStart(7)} ${'img'.padStart(7)}  strategy`
	);
	report('-'.repeat(90));

	let sumIn = 0;
	let sumOut = 0;
	let regressed = 0;

	for (const f of list) {
		const t0 = performance.now();
		const res = await optimize({ bytes: f.bytes, mode }, runner, codec);
		const ms = Math.round(performance.now() - t0);

		// Independent validation of whatever the orchestrator chose.
		const check = await runner(res.bytes, ['--check']);
		const valid = check.code === 0 || check.code === 3;
		const pct = (res.percent);

		const imgCell = res.imagesProcessed ? `${res.imagesReplaced}/${res.imagesProcessed}` : '-';
		report(
			`${f.name.padEnd(26)} ${String(f.bytes.length).padStart(9)} ${String(res.bytes.length).padStart(9)} ` +
				`${String(res.savedBytes).padStart(9)} ${pct.toFixed(1).padStart(6)}% ${String(ms).padStart(7)} ` +
				`${imgCell.padStart(7)}  ${res.strategy}${res.fallback ? ' (no gain, original returned)' : ''}` +
				`${valid ? '' : '  !! INVALID'}`
		);

		if (res.bytes.length > f.bytes.length) regressed++;
		sumIn += f.bytes.length;
		sumOut += res.bytes.length;

		if (process.env.VERBOSE) {
			for (const c of res.candidates) {
				report(
					`      candidate ${c.name.padEnd(12)} ${String(c.bytes).padStart(9)} B  valid=${c.valid}` +
						`${c.lossy ? ' lossy' : ''}${c.rejected ? `  rejected: ${c.rejected}` : ''}`
				);
			}
		}
	}

	report('-'.repeat(90));
	report(`TOTAL ${sumIn} -> ${sumOut} B  ${(((sumIn - sumOut) / sumIn) * 100).toFixed(2)}% smaller`);
	if (regressed) report(`WARNING: ${regressed} fixture(s) came out LARGER than the original`);
	totals.set(mode, { in: sumIn, out: sumOut });
	report('');
}

if (totals.size > 1) {
	report('── summary');
	for (const [mode, t] of totals) {
		report(`   ${mode.padEnd(12)} ${(((t.in - t.out) / t.in) * 100).toFixed(2)}% smaller`);
	}
	report('');
}