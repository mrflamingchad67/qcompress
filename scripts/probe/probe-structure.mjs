/**
 * Does the structure reader agree with reality?
 *
 * Prints what it extracts for each fixture so the parser can be checked by eye
 * before anything is asserted against it. Every fixture is flattened first,
 * because that is the form the reader is specified for.
 *
 * Usage: bun scripts/probe/probe-structure.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readStructure } from '../../src/lib/qpdf/structure.ts';
import { bytesToLatin1 } from '../../src/lib/qpdf/bytes.ts';
import { makeRunner } from '../lib/engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const run = makeRunner();

const dir = path.join(here, '..', 'fixtures');
const files = (await readdir(dir)).filter((f) => f.endsWith('.pdf')).sort();

out('');
for (const f of files) {
	const bytes = new Uint8Array(await readFile(path.join(dir, f)));
	const flat = await run(bytes, ['--object-streams=disable', '--stream-data=preserve']);
	if (!flat.out) {
		out(`${f}: FLATTEN FAILED`);
		continue;
	}
	const s = readStructure(bytesToLatin1(flat.out));

	out(`${f}`);
	out(`  readable=${s.readable} pages=${s.pageCount} declaredCount=${s.declaredCount} objects=${s.objectCount}`);
	out(`  outlines=${s.hasOutlines}(${s.outlineTitles.length}) acroform=${s.hasAcroForm}(${s.formFields.length}) meta=${s.hasMetadata} info=${s.hasInfo} encrypt=${s.hasEncrypt} names=${s.hasNames}`);
	out(`  images=${s.images.size}`);
	for (const [num, img] of [...s.images].slice(0, 3)) {
		out(
			`    obj ${num}: ${img.width}x${img.height} cs=${img.colorspace} bpc=${img.bitsPerComponent} ` +
				`filters=[${img.filters}] smask=${img.hasSMask}`
		);
	}
	for (const p of s.pages.slice(0, 3)) {
		out(
			`    page ${p.index}: mediaBox=${JSON.stringify(p.mediaBox)} rotate=${p.rotate} ` +
				`annots=${p.annotCount}[${p.annotSubtypes.join(',')}] uris=${p.linkUris.length} ` +
				`xobjects=[${p.xobjectNames.join(',')}] unreadable=${p.unreadable}`
		);
	}
	if (s.pages.length > 3) out(`    … ${s.pages.length - 3} more pages`);
	out('');
}