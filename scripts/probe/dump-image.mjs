/** Dump the image object structure of a PDF, before and after a QPDF run. */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildArgs } from '../../src/lib/qpdf/options.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

let quiet = true;
for (const m of ['log', 'error', 'warn', 'info']) console[m] = () => quiet;
const out = (...a) => process.stdout.write(a.join(' ') + '\n');

const glue = await import(pathToFileURL(path.join(root, 'src', 'lib', 'vendors', 'qpdf.js')).href);
const mod = await glue.default({ noInitialRun: true, locateFile: (f) => path.join(root, 'src', 'lib', 'vendors', f) });

const file = process.argv[2] ?? 'photo-q90.pdf';
const bytes = new Uint8Array(await readFile(path.join(here, '..', 'fixtures', file)));

mod.FS.writeFile('/in.pdf', bytes);
quiet = false;
mod.callMain([...buildArgs({
	mode: 'compress', objectStreams: 'generate', compressionLevel: 9,
	recompressFlate: true, streamData: 'compress', decodeLevel: 'generalized'
}), '/in.pdf', '/out.pdf']);
quiet = true;
const result = new Uint8Array(mod.FS.readFile('/out.pdf'));

function dump(label, buf) {
	out(`\n===== ${label} (${buf.length} B) =====`);
	// list every top-level object and show image dicts
	const text = Buffer.from(buf).toString('latin1');
	const objRe = /(\d+) 0 obj\n([\s\S]{0,400}?)stream\n/g;
	let m, n = 0;
	while ((m = objRe.exec(text)) !== null && n < 8) {
		const dict = m[2].replace(/\s+/g, ' ').trim();
		const start = m.index + m[0].length;
		const len = text.indexOf('endstream', start) - start;
		out(`  obj ${m[1]} stream(${len} B): ${dict.slice(0, 200)}`);
		n++;
	}
	// Show the first bytes after the dict to identify the payload
	const first = Buffer.from(buf.subarray(0, 12)).toString('hex');
	out(`  file starts: ${first}`);
}

dump('INPUT', bytes);
dump('OUTPUT', result);

// Also ask qpdf itself what it thinks the image filters are
quiet = false;
mod.callMain(['--json=latest', '--json-key=objects', '/out.pdf']);
quiet = true;