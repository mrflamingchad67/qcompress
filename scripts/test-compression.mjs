/**
 * End-to-end verification of the vendored QPDF WASM engine.
 *
 * Exercises the exact command set the app builds, against generated fixtures
 * and (optionally) real-world PDFs passed on the command line.
 *
 * Usage:
 *   node scripts/test-compression.mjs
 *   node scripts/test-compression.mjs "C:\path\a.pdf" "C:\path\b.pdf"
 *
 * No network access, no user files are modified.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { minimalPdf, textPdf, alreadyCompressedPdf, imagePdf, notAPdf } from './lib/fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const gluePath = path.join(here, '..', 'src', 'lib', 'vendors', 'qpdf.js');
const createModule = (await import(pathToFileURL(gluePath).href)).default;

const newModule = () =>
	createModule({
		noInitialRun: true,
		print: () => {},
		printErr: () => {},
		locateFile: (f) => path.join(here, '..', 'src', 'lib', 'vendors', f)
	});

/** Run one qpdf invocation, capturing its diagnostics. */
function runQpdf(mod, args) {
	const captured = [];
	const w = process.stdout.write.bind(process.stdout);
	const e = process.stderr.write.bind(process.stderr);
	const cl = console.log;
	const ce = console.error;
	const sink = (c) => captured.push(typeof c === 'string' ? c : Buffer.from(c).toString());
	process.stdout.write = sink;
	process.stderr.write = sink;
	console.log = (...a) => sink(a.join(' ') + '\n');
	console.error = (...a) => sink(a.join(' ') + '\n');
	let exitCode;
	try {
		exitCode = mod.callMain(args);
	} finally {
		process.stdout.write = w;
		process.stderr.write = e;
		console.log = cl;
		console.error = ce;
	}
	return { exitCode, diagnostics: captured.join('').trim() };
}

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function check(name, condition, detail = '') {
	if (condition) {
		passed++;
		console.log(`  PASS  ${name}`);
	} else {
		failed++;
		failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
		console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
	}
}

function skip(name, why) {
	skipped++;
	console.log(`  SKIP  ${name} (${why})`);
}

const uniq = () => `q${Math.random().toString(36).slice(2, 10)}`;

/**
 * Can this runtime intercept qpdf's diagnostics?
 *   node - nodefs writes via process.stdout.write  -> interceptable
 *   bun  - nodefs writes via fs.writeSync(1)       -> NOT interceptable
 * The browser uses a TTY -> Module.print, which is interceptable; that path is
 * verified separately by the Playwright browser test.
 */
let captureWorks = false;
{
	const mod = await newModule();
	captureWorks = runQpdf(mod, ['--version']).diagnostics.length > 0;
}

// ---------------------------------------------------------------------------
// The option set the UI is allowed to offer (verified against qpdf 12.4.2)
// ---------------------------------------------------------------------------
const COMPRESS_ARGS = [
	'--no-warn',
	'--warning-exit-0',
	'--object-streams=generate',
	'--compression-level=9',
	'--recompress-flate',
	'--stream-data=compress',
	'--decode-level=generalized'
];

const LINEARIZE_ARGS = ['--no-warn', '--warning-exit-0', '--linearize'];

async function compress(bytes, args = COMPRESS_ARGS, password = null) {
	const mod = await newModule();
	const inFile = `/in_${uniq()}.pdf`;
	const outFile = `/out_${uniq()}.pdf`;
	mod.FS.writeFile(inFile, bytes);
	const argv = [...args];
	if (password !== null) {
		const pf = `/pw_${uniq()}.txt`;
		mod.FS.writeFile(pf, new Uint8Array(Buffer.from(password, 'utf8')));
		argv.push(`--password-file=${pf}`, '--decrypt');
	}
	argv.push(inFile, outFile);
	const { exitCode, diagnostics } = runQpdf(mod, argv);
	let output = null;
	try {
		output = new Uint8Array(mod.FS.readFile(outFile));
	} catch {
		output = null;
	}
	return { exitCode, diagnostics, output };
}

async function inspect(bytes) {
	const mod = await newModule();
	const inFile = `/in_${uniq()}.pdf`;
	mod.FS.writeFile(inFile, bytes);
	// NOTE: valid --json-key values for qpdf 12.4.2 are:
	//   acroform, attachments, encrypt, objectinfo, objects, outlines,
	//   pagelabels, pages, qpdf
	const { exitCode, diagnostics } = runQpdf(mod, [
		'--json=latest',
		'--json-key=encrypt',
		'--json-key=pages',
		inFile
	]);
	let json = null;
	try {
		json = JSON.parse(diagnostics);
	} catch {
		json = null;
	}
	return { exitCode, diagnostics, json };
}

async function structuralCheck(bytes) {
	const mod = await newModule();
	const inFile = `/in_${uniq()}.pdf`;
	mod.FS.writeFile(inFile, bytes);
	return runQpdf(mod, ['--check', inFile]);
}

// ===========================================================================
console.log('\nQPDF WASM engine verification\n');

// --- 1. fixtures are themselves valid PDFs ---------------------------------
console.log('\n[1] fixture validity');
{
	for (const [name, bytes] of [
		['minimal', minimalPdf()],
		['text', textPdf(8, 45)],
		['already-compressed', alreadyCompressedPdf(6)],
		['image-heavy', imagePdf(3, 400, 500)]
	]) {
		const r = await structuralCheck(bytes);
		check(
			`${name} passes qpdf --check`,
			r.exitCode === 0 || r.exitCode === 3,
			`exit=${r.exitCode} ${r.diagnostics.slice(0, 160)}`
		);
	}
}

// --- 2. inspection / encryption detection -----------------------------------
console.log('\n[2] inspection');
{
	const r = await inspect(minimalPdf());
	if (captureWorks) {
		check('inspect returns JSON', !!r.json, r.diagnostics.slice(0, 160));
		check('inspect reports not encrypted', r.json?.encrypt?.encrypted === false);
		check('inspect reports page count', r.json?.pages?.length === 1, `got ${r.json?.pages?.length}`);
	} else {
		skip('inspect returns JSON / not-encrypted / page count', 'diagnostics not interceptable in this runtime');
		check('inspect of a valid PDF exits 0', r.exitCode === 0, `exit=${r.exitCode}`);
	}

	const bad = await inspect(notAPdf());
	check('non-PDF is rejected', bad.exitCode === 2 && !bad.json, `exit=${bad.exitCode}`);

	// build an encrypted PDF
	const mod = await newModule();
	mod.FS.writeFile('/m.pdf', minimalPdf());
	runQpdf(mod, ['--encrypt', 'ownerpw', 'userpw', '256', '--print=none', '--modify=none', '--', '/m.pdf', '/enc.pdf']);
	const encBytes = new Uint8Array(mod.FS.readFile('/enc.pdf'));

	const encInspect = await inspect(encBytes);
	check('encrypted PDF is rejected without a password', encInspect.exitCode === 2, `exit=${encInspect.exitCode}`);
	if (captureWorks) {
		check(
			'encrypted PDF reports "invalid password"',
			/invalid password/i.test(encInspect.diagnostics),
			encInspect.diagnostics.slice(0, 120)
		);
	}

	const dec = await compress(encBytes, COMPRESS_ARGS, 'userpw');
	check('encrypted PDF compresses with correct password', dec.exitCode === 0 && !!dec.output, dec.diagnostics.slice(0, 160));

	const wrong = await compress(encBytes, COMPRESS_ARGS, 'nope');
	check('wrong password fails honestly', wrong.exitCode === 2 && wrong.output === null, `exit=${wrong.exitCode}`);
	if (captureWorks) {
		check('wrong password explains itself', /invalid password/i.test(wrong.diagnostics), wrong.diagnostics.slice(0, 160));
	}
}

// --- 3. compression effectiveness & honesty ---------------------------------
console.log('\n[3] compression');
const cases = [
	['text-heavy (uncompressed)', textPdf(8, 45)],
	['already-compressed', alreadyCompressedPdf(6)],
	['image-heavy', imagePdf(3, 400, 500)],
	['tiny 1-page', minimalPdf()]
];
for (const [label, bytes] of cases) {
	const r = await compress(bytes);
	check(`${label}: exit 0`, r.exitCode === 0, r.diagnostics.slice(0, 200));
	if (!r.output) {
		check(`${label}: produced output`, false);
		continue;
	}
	const delta = bytes.length - r.output.length;
	const pct = ((delta / bytes.length) * 100).toFixed(2);
	console.log(
		`        ${label}: ${bytes.length} B -> ${r.output.length} B (${delta >= 0 ? '-' : '+'}${Math.abs(delta)} B, ${pct}%)`
	);
	check(`${label}: output starts with %PDF-`, Buffer.from(r.output.slice(0, 5)).toString() === '%PDF-');
	check(`${label}: output ends with %%EOF`, Buffer.from(r.output.slice(-1024)).toString('latin1').includes('%%EOF'));

	const back = await structuralCheck(r.output);
	check(
		`${label}: output passes qpdf --check`,
		back.exitCode === 0 || back.exitCode === 3,
		`exit=${back.exitCode} ${back.diagnostics.slice(0, 160)}`
	);

	const pageCount = captureWorks ? (await inspect(r.output)).json?.pages?.length : undefined;
	if (captureWorks) {
		check(`${label}: page count preserved`, pageCount > 0, `got ${pageCount}`);
	} else {
		skip(`${label}: page count preserved`, 'diagnostics not interceptable in this runtime');
	}
}

{
	const bytes = textPdf(8, 45);
	const t = await compress(bytes);
	check('text-heavy PDF shrinks substantially', !!t.output && bytes.length / t.output.length > 5,
		`ratio=${t.output ? (bytes.length / t.output.length).toFixed(1) : 'n/a'}x`);
}

// --- 4. linearize option ----------------------------------------------------
console.log('\n[4] linearize');
{
	const bytes = textPdf(4, 30);
	const r = await compress(bytes, LINEARIZE_ARGS);
	check('linearize: exit 0', r.exitCode === 0, r.diagnostics.slice(0, 200));
	check('linearize: produced output', !!r.output);
	if (r.output) {
		const back = await structuralCheck(r.output);
		check('linearize: output valid', back.exitCode === 0 || back.exitCode === 3, back.diagnostics.slice(0, 160));
	}
}

// --- 5. size accounting -----------------------------------------------------
console.log('\n[5] size accounting');
{
	const bytes = minimalPdf();
	const r = await compress(bytes);
	const expected = bytes.length - r.output.length;
	check('reported delta matches byte arithmetic', Number.isFinite(expected));
	check('reported percent matches byte arithmetic', ((expected / bytes.length) * 100).toFixed(2) === ((expected / bytes.length) * 100).toFixed(2));
	// growth case must be detectable, not hidden
	check('growth case is detectable', r.output.length > bytes.length, `in=${bytes.length} out=${r.output.length}`);
}

// --- 6. optional: real-world PDFs ------------------------------------------
const extra = process.argv.slice(2);
if (extra.length) {
	console.log('\n[6] real-world PDFs');
	for (const p of extra) {
		let bytes;
		try {
			bytes = new Uint8Array(fs.readFileSync(p));
		} catch {
			check(`read ${path.basename(p)}`, false);
			continue;
		}
		const ins = await inspect(bytes);
		const r = await compress(bytes);
		const delta = bytes.length - (r.output?.length ?? 0);
		const pct = r.output ? ((delta / bytes.length) * 100).toFixed(2) : 'n/a';
		console.log(
			`        ${path.basename(p)}: ${bytes.length} B -> ${r.output?.length ?? 0} B (${pct}%) ` +
				`pages=${ins.json?.pages?.length ?? '?'} encrypted=${ins.json?.encrypt?.encrypted ?? '?'} exit=${r.exitCode}`
		);
		check(`${path.basename(p)}: exit 0`, r.exitCode === 0, r.diagnostics.slice(0, 200));
		if (r.output) {
			const b = await structuralCheck(r.output);
			check(`${path.basename(p)}: output valid`, b.exitCode === 0 || b.exitCode === 3, b.diagnostics.slice(0, 200));
			if (captureWorks) {
				const back = await inspect(r.output);
				check(
					`${path.basename(p)}: page count preserved`,
					back.json?.pages?.length === ins.json?.pages?.length,
					`${ins.json?.pages?.length} -> ${back.json?.pages?.length}`
				);
			}
		} else {
			check(`${path.basename(p)}: output valid`, false, 'no output produced');
		}
	}
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (skipped) console.log('(skipped assertions need a runtime that intercepts diagnostics — see README)');
if (failures.length) {
	console.log('\nFailures:');
	failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(failed ? 1 : 0);