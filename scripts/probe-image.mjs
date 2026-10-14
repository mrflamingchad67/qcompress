/**
 * Why does a single-image PDF shrink so much?
 *
 * QPDF must not be re-encoding image data. This compares the embedded stream
 * bytes before and after a run to prove what actually changed.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildArgs } from '../src/lib/qpdf/options.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let quiet = true;
for (const m of ['log', 'error', 'warn', 'info']) console[m] = () => quiet;
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

const glue = await import(pathToFileURL(path.join(root, 'src', 'lib', 'vendors', 'qpdf.js')).href);
const mod = await glue.default({ noInitialRun: true, locateFile: (f) => path.join(root, 'src', 'lib', 'vendors', f) });

const file = process.argv[2] ?? 'photo-q90.pdf';
const bytes = new Uint8Array(await readFile(path.join(here, 'fixtures', file)));

mod.FS.writeFile('/in.pdf', bytes);
const args = [...buildArgs({
	mode: 'compress', objectStreams: 'generate', compressionLevel: 9,
	recompressFlate: true, streamData: 'compress', decodeLevel: 'generalized'
}), '/in.pdf', '/out.pdf'];
quiet = false;
mod.callMain(args);
quiet = true;
const out = new Uint8Array(mod.FS.readFile('/out.pdf'));

/** Describe every stream in a buffer. */
function streams(buf) {
	const text = Buffer.from(buf).toString('latin1');
	const out = [];
	const re = /\/Subtype\s*\/Image[\s\S]{0,300}?\/(?:Filter\s*\/(\w+)|Filter\s*\[\s*\/(\w+))[\s\S]{0,200}?stream\r?\n/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const start = m.index + m[0].length;
		const end = text.indexOf('endstream', start);
		out.push({ filter: m[1] ?? m[2], bytes: end - start });
	}
	return out;
}

report(`\n${file}`);
report(`  whole file : ${bytes.length} -> ${out.length} B`);
report('  image streams in input :', JSON.stringify(streams(bytes)));
report('  image streams in output:', JSON.stringify(streams(out)));

// Is the JPEG payload byte-identical?
const grab = (buf) => {
	const b = Buffer.from(buf);
	const i = b.indexOf(Buffer.from([0xff, 0xd8, 0xff])); // JPEG SOI
	const j = b.lastIndexOf(Buffer.from([0xff, 0xd9])); // JPEG EOI
	return i === -1 || j === -1 ? null : b.subarray(i, j + 2);
};
const a = grab(bytes);
const b = grab(out);
report(`  JPEG payload: ${a ? a.length : 'none'} B -> ${b ? b.length : 'none'} B`);
if (a && b) report(`  JPEG byte-identical: ${a.equals(b)}`);
report();