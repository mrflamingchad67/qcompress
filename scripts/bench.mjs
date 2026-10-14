/**
 * Compression benchmark harness.
 *
 * Measures a real strategy against real fixtures and reports honest numbers:
 * bytes in/out, bytes saved, percentage, duration, and whether the output
 * actually validates. Fixtures that cannot improve are reported as such rather
 * than hidden.
 *
 * Imports buildArgs() from src/ so the benchmark can never drift from what the
 * app actually ships.
 *
 * Usage: bun scripts/bench.mjs [strategy] [fixture ...]
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { buildArgs } from '../src/lib/qpdf/options.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/*
 * Silence qpdf.
 *
 * The Emscripten glue binds console.log when its module is first evaluated, so
 * the sink must exist before the glue is imported. That means the glue is
 * loaded lazily, not at the top of the file.
 */
let quiet = false;
for (const m of ['log', 'error', 'warn', 'info']) {
	console[m] = () => quiet;
}

const glue = await import(pathToFileURL(path.join(root, 'src', 'lib', 'vendors', 'qpdf.js')).href);
const createModule = glue.default;

const newModule = () =>
	createModule({
		noInitialRun: true,
		locateFile: (f) => path.join(root, 'src', 'lib', 'vendors', f)
	});

function run(mod, args) {
	const captured = [];
	const sink = (c) => captured.push(typeof c === 'string' ? c : Buffer.from(c).toString());
	quiet = false;
	const orig = { log: console.log, error: console.error };
	console.log = sink;
	console.error = sink;
	let code;
	try {
		code = mod.callMain(args);
	} finally {
		Object.assign(console, orig);
		quiet = true;
	}
	return { code, text: captured.join('') };
}

let uid = 0;
const tmp = (p, x) => `${p}_${Date.now().toString(36)}_${uid++}${x}`;

/** Run one strategy over a buffer; returns output bytes or null. */
export async function compress(bytes, args, password = null) {
	const mod = await newModule();
	const inF = tmp('in', '.pdf');
	const outF = tmp('out', '.pdf');
	let passF = null;
	try {
		mod.FS.writeFile(inF, bytes);
		const a = [...args];
		if (password !== null) {
			passF = tmp('pw', '.txt');
			mod.FS.writeFile(passF, new Uint8Array(Buffer.from(password, 'utf8')));
			a.push(`--password-file=${passF}`, '--decrypt');
		}
		a.push(inF, outF);
		const r = run(mod, a);
		if (r.code !== 0) return { ok: false, reason: r.text.trim().slice(0, 200), exit: r.code };
		try {
			return { ok: true, output: new Uint8Array(mod.FS.readFile(outF)) };
		} catch {
			return { ok: false, reason: 'no output file', exit: r.code };
		}
	} finally {
		for (const p of [inF, outF, passF].filter(Boolean)) {
			try { mod.FS.unlink(p); } catch {}
		}
	}
}

/** Structural check plus the header/trailer sanity a browser needs. */
export async function validate(bytes) {
	const mod = await newModule();
	const f = tmp('v', '.pdf');
	try {
		mod.FS.writeFile(f, bytes);
		const r = run(mod, ['--check', f]);
		const head = Buffer.from(bytes.subarray(0, 5)).toString();
		const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 2048))).toString('latin1');
		const pages = (r.text.match(/PDF Version:/) && true) || false;
		return {
			ok: r.code === 0 || r.code === 3,
			exit: r.code,
			headerOk: head === '%PDF-',
			eofOk: tail.includes('%%EOF'),
			pages: pages,
			detail: r.text.trim().split('\n').slice(-1)[0]
		};
	} finally {
		try { mod.FS.unlink(f); } catch {}
	}
}

/* ── fixture discovery ──────────────────────────────────────────────────── */

async function fixtures() {
	const dir = path.join(here, 'fixtures');
	const files = (await readdir(dir)).filter((f) => f.endsWith('.pdf')).sort();
	return Promise.all(
		files.map(async (f) => ({ name: f, bytes: new Uint8Array(await readFile(path.join(dir, f))) }))
	);
}

/* ── run ────────────────────────────────────────────────────────────────── */

const STRATEGY = process.argv[2] ?? 'current';
const only = process.argv.slice(3);

const ARGS = {
	current: buildArgs({
		mode: 'compress',
		objectStreams: 'generate',
		compressionLevel: 9,
		recompressFlate: true,
		streamData: 'compress',
		decodeLevel: 'generalized'
	})
};

const all = await fixtures();
const list = only.length ? all.filter((f) => only.includes(f.name)) : all;

// Restore normal console output for the report itself.
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

report(`\nBenchmark - strategy "${STRATEGY}"`);
report(`${'fixture'.padEnd(26)} ${'in'.padStart(9)} ${'out'.padStart(9)} ${'saved'.padStart(9)} ${'%'.padStart(8)} ${'ms'.padStart(7)}  valid`);
report('-'.repeat(84));

const rows = [];
for (const f of list) {
	const t0 = performance.now();
	const r = await compress(f.bytes, ARGS[STRATEGY] ?? ARGS.current);
	const ms = Math.round(performance.now() - t0);

	if (!r.ok) {
		report(
			`${f.name.padEnd(26)} ${String(f.bytes.length).padStart(9)} ${'FAIL'.padStart(9)} ` +
				`${''.padStart(9)} ${''.padStart(8)} ${String(ms).padStart(7)}  ${r.reason}`
		);
		rows.push({ name: f.name, in: f.bytes.length, out: null, saved: null, pct: null, ms, valid: false });
		continue;
	}

	const v = await validate(r.output);
	const saved = f.bytes.length - r.output.length;
	const pct = (saved / f.bytes.length) * 100;
	const ok = v.ok && v.headerOk && v.eofOk;

	report(
		`${f.name.padEnd(26)} ${String(f.bytes.length).padStart(9)} ${String(r.output.length).padStart(9)} ` +
			`${String(saved).padStart(9)} ${pct.toFixed(1).padStart(7)}% ${String(ms).padStart(7)}  ${ok ? 'yes' : 'NO'}`
	);
	rows.push({ name: f.name, in: f.bytes.length, out: r.output.length, saved, pct, ms, valid: ok });
}

const valid = rows.filter((r) => r.valid);
const totIn = valid.reduce((a, r) => a + r.in, 0);
const totOut = valid.reduce((a, r) => a + r.out, 0);
report('-'.repeat(84));
report(
	`TOTAL (${valid.length}/${rows.length} valid): ${totIn} -> ${totOut} B  ` +
		`${(((totIn - totOut) / totIn) * 100).toFixed(2)}% smaller`
);
const noWin = rows.filter((r) => r.valid && r.saved <= 0).map((r) => r.name);
if (noWin.length) report(`No reduction: ${noWin.join(', ')}`);
report();