/**
 * verify:file - run one local PDF through every preservation check in one command.
 *
 * The suites answer "does the corpus hold?". This answers "does THIS document?",
 * for a file that is not in the corpus: a customer's PDF, a document about to
 * be emailed, anything you actually care about.
 *
 * It deliberately reuses the suites' own comparators and thresholds rather than
 * defining its own. A tool with its own idea of "acceptable" would drift from
 * what CI enforces, and then one of the two would be lying. The checks are:
 *
 *   structural  qpdf --check on the output, and the page count is unchanged.
 *   text        every string handed to Tj / TJ / ' / " survives, in order, on
 *               every page. A page whose content stream cannot be read is
 *               reported as a coverage gap, never as a pass.
 *   visual      pages rendered through PDF.js and compared against the original
 *               under the same VISUAL_POLICY the visual suite gates on.
 *
 * WHAT A PASS HERE DOES NOT MEAN
 *
 * A green result is evidence about one document, not a guarantee about the
 * software. It does not cover annotations, tagged-PDF validity, /ToUnicode
 * correctness, reading order, or accessibility - none of which any check here
 * measures. The text comparison is over font-encoded bytes, not Unicode.
 *
 * Usage:
 *   bun run verify:file <file.pdf> [--mode lossless|balanced|maximum]
 *                                   [--all] [--hostile] [--save <out.pdf>]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { optimize } from '../../src/lib/qpdf/pipeline.ts';
import { bytesToLatin1 } from '../../src/lib/qpdf/bytes.ts';
import { makeRunner, makeCodec, makeZip } from '../lib/engine.mjs';
import { findJpegImages, isReencodable } from '../../src/lib/qpdf/images.ts';
import { extractTextSignature } from '../lib/textlayer.mjs';
import { compareText, describeTextProblems } from '../lib/textcompare.mjs';
import { startRenderer } from '../lib/render.mjs';
import { policyFor, formatViolations } from '../lib/visual.mjs';

const report = (...a) => process.stdout.write(a.join(' ') + '\n');

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const file = positional[0];
const ALL_MODES = has('all');
const HOSTILE = has('hostile');
const SAVE = flag('save');

if (!file || has('help')) {
	report('');
	report('usage: bun run verify:file <file.pdf> [options]');
	report('');
	report('  --mode <m>    lossless | balanced | maximum   (default maximum)');
	report('  --all         check all three modes');
	report('  --hostile     use the hostile-fixture visual bounds');
	report('  --save <out>  write the compressed document');
	report('');
	process.exit(file ? 0 : 2);
}

const MODES = ALL_MODES ? ['lossless', 'balanced', 'maximum'] : [flag('mode') ?? 'maximum'];
for (const m of MODES) {
	if (!['lossless', 'balanced', 'maximum'].includes(m)) {
		report(`unknown mode "${m}" - expected lossless, balanced or maximum`);
		process.exit(2);
	}
}

const FLATTEN = ['--object-streams=disable', '--stream-data=preserve'];
const runner = makeRunner();
const codec = await makeCodec();
const zip = makeZip();

/* ── helpers ───────────────────────────────────────────────────────────────── */

const ok = (s) => report(`  ok    ${s}`);
const bad = (s) => report(`  FAIL  ${s}`);
const note = (s) => report(`        ${s}`);

async function flatten(bytes) {
	const r = await runner(bytes, FLATTEN);
	return r.out ? bytesToLatin1(r.out) : null;
}

/** Count re-encodable images, which decides the visual policy. */
async function reencodableCount(bytes) {
	const text = await flatten(bytes);
	if (text === null) return null;
	return findJpegImages(text).filter(isReencodable).length;
}

/* ── load ──────────────────────────────────────────────────────────────────── */

report('');
report(`verify:file  ${path.basename(file)}`);

let input;
try {
	input = new Uint8Array(await readFile(file));
} catch (err) {
	report(`  FAIL  could not read the file: ${err.message}`);
	report('');
	process.exit(1);
}

let inFlat = await flatten(input);
if (inFlat === null) {
	report(`  FAIL  qpdf could not read this document at all - it is not a PDF this tool can verify`);
	report('');
	process.exit(1);
}

const mayReencode = (await reencodableCount(input)) > 0;
const pagesIn = (inFlat.match(/\/Type\s*\/Page[^s]/g) ?? []).length;

/* ── run ───────────────────────────────────────────────────────────────────── */

const renderer = await startRenderer({});
let overallFailed = false;

try {
	for (const mode of MODES) {
		report('');
		report(`[${mode}]`);

		let out;
		try {
			out = await optimize({ bytes: input, mode, zip }, runner, codec);
		} catch (err) {
			bad(`compression threw: ${err.message}`);
			overallFailed = true;
			continue;
		}

		if (SAVE) {
			const target = ALL_MODES && MODES.length > 1 ? SAVE.replace(/(\.pdf)?$/i, `-${mode}.pdf`) : SAVE;
			await writeFile(target, out.bytes);
			report(`  wrote ${target}`);
		}

		const saved = ((input.length - out.bytes.length) / input.length) * 100;
		report(
			`  ${input.length.toLocaleString()} B -> ${out.bytes.length.toLocaleString()} B  ` +
				`(${saved.toFixed(2)}% smaller, ${out.strategy})`
		);
		report(`  images re-encoded ${out.imagesReplaced}/${out.imagesProcessed}`);
		if (out.imageSkips?.length) {
			for (const s of out.imageSkips) note(`skipped ${s.count} image(s): ${s.reason}`);
		}
		if (out.fallback) note('no candidate beat the original; the original is returned unchanged');

		/* structural */
		let structureOk = true;
		const chk = await runner(out.bytes, ['--check']);
		if (chk.code !== 0) {
			bad(`structural: qpdf --check exited ${chk.code}`);
			note((chk.diagnostics || '').trim().split('\n').slice(0, 6).join('\n        '));
			structureOk = false;
		}

		const outFlat = await flatten(out.bytes);
		if (outFlat === null) {
			bad('structural: qpdf could not flatten the output');
			structureOk = false;
		} else {
			const pagesOut = (outFlat.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
			if (pagesOut !== pagesIn) {
				bad(`structural: page count changed ${pagesIn} -> ${pagesOut}`);
				structureOk = false;
			} else if (chk.code === 0) {
				ok(`structural: qpdf --check clean, ${pagesOut} page(s) unchanged`);
			}
		}

		/* text */
		let textOk = false;
		if (outFlat) {
			const [sa, sb] = [
				await extractTextSignature(inFlat, zip.inflate),
				await extractTextSignature(outFlat, zip.inflate)
			];

			if (sa.pageCount !== sb.pageCount) {
				bad(`text: page count differs (${sa.pageCount} -> ${sb.pageCount})`);
			} else {
				const unreadable = [
					...sa.unsupportedPages.map((u) => `original p${u.page}: ${u.reason}`),
					...sb.unsupportedPages.map((u) => `candidate p${u.page}: ${u.reason}`)
				];
				if (unreadable.length) {
					/* Not a pass. An unreadable content stream is an unknown page,
					 * and reporting it as one is the entire reason the text suite
					 * has negative controls. */
					bad(`text: ${unreadable.length} page(s) could not be read - a coverage gap, not a pass`);
					note(unreadable.slice(0, 8).join('\n        '));
				} else {
					const r = compareText(sa, sb);
					const ops = r.pages.reduce((n, p) => n + p.ops, 0);
					const bytesOfText = r.pages.reduce((n, p) => n + p.bytes, 0);
					if (r.ok) {
						textOk = true;
						ok(
							`text: ${r.pages.length} page(s) compared, ${ops} text op(s) / ${bytesOfText}B preserved` +
								(bytesOfText === 0 ? '  (no text layer - preservation is vacuous, not verified)' : '')
						);
					} else {
						bad(`text: ${describeTextProblems(r.problems)}`);
					}
				}
			}
		}

		/* visual */
		let visualOk = false;
		try {
			const policy = policyFor(mode, HOSTILE, mayReencode);
			const result = await renderer.comparePair(input, out.bytes, mode, HOSTILE, mayReencode);

			if (result.errors?.length) {
				bad(`visual: renderer reported errors: ${result.errors.slice(0, 2).join(' | ')}`);
			} else if (result.geometry?.problems?.length) {
				bad(`visual: geometry changed`);
				for (const g of result.geometry.problems.slice(0, 6)) {
					note(`${g.page ? `page ${g.page} ` : ''}[${g.kind}] ${g.detail}`);
				}
			} else {
				const failing = result.pages.filter((p) => !p.ok);
				if (failing.length) {
					bad(`visual: ${failing.length} of ${result.pages.length} page(s) outside the ${policy.group} policy`);
					for (const p of failing.slice(0, 8)) {
						note(
							`page ${p.page}: ` +
								(p.violations.length ? formatViolations(p.violations) : p.reason ?? 'unknown')
						);
					}
					if (failing.length > 8) note(`...and ${failing.length - 8} more`);
				} else {
					visualOk = true;
					const a = result.aggregate;
					ok(
						`visual: ${a.pages} page(s) under the ${policy.group} policy - ` +
							`changed ${a.changedPct.toFixed(3)}%, hard ${a.hardPct.toFixed(3)}%, MAE ${a.mae.toFixed(3)}`
					);
					if (a.worstPage) note(`worst page: ${a.worstPage}`);
				}
			}
		} catch (err) {
			bad(`visual: could not render - ${String(err.message).split('\n')[0]}`);
		}

		if (!(structureOk && textOk && visualOk)) overallFailed = true;
	}
} finally {
	await renderer.release();
}

report('');
if (overallFailed) {
	report('FAILED  at least one check did not pass for this document');
} else {
	report('PASSED  structural, text and visual checks all passed for this document');
}
report('');

process.exit(overallFailed ? 1 : 0);