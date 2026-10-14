/**
 * Probe: how many fixtures contain byte-identical duplicate streams?
 *
 * Duplicated images are extremely common in real PDFs - a shared logo, a
 * repeated scan header, one background stamped on every page. Each copy is
 * stored in full, and deduplicating them is a pure lossless win: the surviving
 * object is referenced in place of the copies, so every pixel is unchanged.
 */
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { findJpegImages } from '../src/lib/qpdf/images.ts';
import { makeRunner } from './engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const runner = makeRunner();

const dir = path.join(here, 'fixtures');
const files = (await readdir(dir)).filter((f) => f.endsWith('.pdf')).sort();

out('');
out(`${'fixture'.padEnd(26)} ${'images'.padStart(7)} ${'distinct'.padStart(9)} ${'dup bytes'.padStart(12)} ${'potential'.padStart(10)}`);
out('-'.repeat(72));

for (const f of files) {
	const bytes = new Uint8Array(await readFile(path.join(dir, f)));

	// Flatten so every stream is a top-level object.
	const flat = await runner(bytes, ['--object-streams=disable', '--stream-data=preserve']);
	if (!flat.out) {
		out(`${f.padEnd(26)} ${'(flatten failed)'.padStart(10)}`);
		continue;
	}
	const text = Buffer.from(flat.out).toString('latin1');
	const images = findJpegImages(text);

	// Group by payload size first - cheap, and a mismatch rules out identity.
	const bySize = new Map();
	for (const img of images) {
		if (!bySize.has(img.length)) bySize.set(img.length, []);
		bySize.get(img.length).push(img);
	}

	let dupBytes = 0;
	for (const group of bySize.values()) {
		if (group.length < 2) continue;
		// Confirm with a real byte comparison, not just equal lengths.
		const first = group[0].data;
		for (let i = 1; i < group.length; i++) {
			const cand = group[i].data;
			let same = true;
			for (let k = 0; k < first.length; k++) {
				if (first[k] !== cand[k]) {
					same = false;
					break;
				}
			}
			if (same) dupBytes += first.length;
		}
	}

	const potential = bytes.length ? (dupBytes / bytes.length) * 100 : 0;
	out(
		`${f.padEnd(26)} ${String(images.length).padStart(7)} ${String(bySize.size).padStart(9)} ` +
			`${String(dupBytes).padStart(12)} ${potential.toFixed(1).padStart(9)}%`
	);
}
out('');