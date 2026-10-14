/**
 * What can QPDF actually tell us about a document?
 *
 * The integrity suite needs to compare *semantics* (page sizes, rotation,
 * annotations, outlines, form fields) rather than just "does it parse". This
 * dumps the real `--json` shape so the comparison layer is built on fields the
 * vendored build genuinely emits, not on guesses.
 *
 * Usage: bun scripts/probe/probe-json.mjs [fixture.pdf]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRunner } from '../lib/engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = (...a) => process.stdout.write(a.join(' ') + '\n');

// --json cannot be reused on one instance, so ask for everything at once.
// `objects` / `objectinfo` are rejected by --json=latest (they are json
// version 1 only), so they are not requested here.
const KEYS = ['pages', 'acroform', 'attachments', 'outlines', 'encrypt', 'pagelabels', 'qpdf'];

const runner = makeRunner();
const file = process.argv[2] ?? 'scan-300dpi-q80.pdf';
const bytes = new Uint8Array(await readFile(path.join(here, '..', 'fixtures', file)));

const r = await runner(bytes, ['--json=latest', ...KEYS.map((k) => `--json-key=${k}`)]);
out(`${file}: exit ${r.code}`);

const start = r.diagnostics.indexOf('{');
if (start === -1) {
	out('no json emitted');
	out(r.diagnostics.slice(0, 800));
	process.exit(1);
}

let json;
try {
	json = JSON.parse(r.diagnostics.slice(start));
} catch (e) {
	out(`json parse failed: ${e.message}`);
	out(r.diagnostics.slice(start, start + 600));
	process.exit(1);
}

out(`\ntop-level keys: ${Object.keys(json).join(', ')}`);

/** Show the shape of a value without dumping a whole document. */
function shape(value, depth = 0, label = '') {
	if (depth > 3) return '…';
	if (Array.isArray(value)) {
		out(`${'  '.repeat(depth)}${label}: array(${value.length})`);
		if (value.length) shape(value[0], depth + 1, '[0]');
		return;
	}
	if (value && typeof value === 'object') {
		out(`${'  '.repeat(depth)}${label}: {${Object.keys(value).join(', ')}}`);
		for (const k of Object.keys(value)) shape(value[k], depth + 1, k);
		return;
	}
	out(`${'  '.repeat(depth)}${label}: ${JSON.stringify(value)}`);
}

for (const key of ['qpdf', 'pages', 'acroform', 'attachments', 'outlines', 'pagelabels']) {
	out(`\n--- ${key} ---`);
	if (key === 'pages' && Array.isArray(json.pages)) {
		out(`  pages: array(${json.pages.length})`);
		shape(json.pages[0], 2, '[0]');
		continue;
	}
	shape(json[key], 1, key);
}

out('');