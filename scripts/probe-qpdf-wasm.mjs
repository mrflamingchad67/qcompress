/**
 * Probe the vendored QPDF WASM build.
 *
 * This is a *verification* script: it establishes ground truth about the
 * engine we ship (version, option support, FS semantics) so the UI only ever
 * exposes options that this exact build accepts.
 *
 * Run: npm run wasm:probe
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const gluePath = path.join(here, '..', 'src', 'lib', 'vendors', 'qpdf.js');

const createModule = (await import(pathToFileURL(gluePath).href)).default;

// Emscripten writes stdout/stderr through Module.print / Module.printErr.
let out = [];
let err = [];

const mod = await createModule({
	print: (s) => out.push(s),
	printErr: (s) => err.push(s),
	locateFile: (f) => path.join(here, '..', 'src', 'lib', 'vendors', f)
});

console.log('ENV                :', JSON.stringify(mod.ENV));
console.log('runtime methods    :', ['callMain', 'FS', 'ENV'].filter((k) => k in mod).join(', ') || '(none)');
console.log('FS extra methods   :', ['init', 'unlink', 'writeFile', 'readFile', 'stat'].filter((k) => k in mod.FS).join(', '));

// --- version -----------------------------------------------------------------
out = []; err = [];
mod.callMain(['--version']);
console.log('\n--- qpdf --version ---');
console.log([...out, ...err].join('').trim());

// --- help (authoritative option list for THIS build) -------------------------
out = []; err = [];
mod.callMain(['--help']);
const help = [...out, ...err].join('');
console.log('\n--- option presence in this build ---');
const OPTION_PROBES = [
	'--object-streams=',
	'--compression-level=',
	'--recompress-flate',
	'--stream-data=',
	'--decode-level=',
	'--linearize',
	'--decrypt',
	'--password-file=',
	'--remove-restrictions',
	'--check',
	'--json',
	'--show-encryption',
	'--flatten-annotations',
	'--colours',
	'--normalize-content',
	'--newline-before-endstream',
	'--qdf',
	'--min-semi-linear',
	'--decode-level=all'
];
for (const probe of OPTION_PROBES) {
	console.log(`${help.includes(probe.replace(/=$/, '')) ? 'YES' : 'no '}  ${probe}`);
}

// --- FS.readFile semantics ---------------------------------------------------
// Critical for correct size reporting: does readFile return a heap subarray
// (whose .buffer.byteLength is the whole WASM heap) or an exact-size copy?
mod.FS.writeFile('/probe.bin', new Uint8Array([1, 2, 3, 4, 5]));
const read = mod.FS.readFile('/probe.bin');
console.log('\n--- FS.readFile semantics ---');
console.log('return ctor       :', read.constructor.name);
console.log('returned .length  :', read.length);
console.log('returned .byteLength:', read.byteLength);
console.log('.buffer.byteLength:', read.buffer.byteLength);
console.log(
	read.buffer.byteLength > read.length
		? '=> SUBAVIEW of heap: .buffer is the WHOLE HEAP (never use it as file size)'
		: '=> exact-size buffer'
);
mod.FS.unlink('/probe.bin');