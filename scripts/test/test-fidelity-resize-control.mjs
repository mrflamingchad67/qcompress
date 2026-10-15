/**
 * Negative control for the new like-for-like comparison in the fidelity suite.
 *
 * The fix makes the suite resize the ORIGINAL to the output's dimensions and
 * compare there, instead of dropping images whose size changed. Before this
 * control existed, the suite had no negative control of any kind, so there was
 * no proof that this comparison could fail on damaged input - a comparison that
 * cannot fail is not a check.
 *
 * The trap this has to avoid: resizing both sides is an aggressive operation on
 * compressed photographic data, and naive noise can easily blow the mae limit on
 * its own. If damage is already outside the limit before any damage is injected,
 * the control proves nothing either. So each case is reported with a BASELINE and
 * a damaged value, and only counts as a control if the baseline is clean.
 *
 * Run: bun scripts/test/test-fidelity-resize-control.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { optimize } from '../../src/lib/qpdf/pipeline.ts';
import { makeRunner, makeCodec, makeZip } from '../lib/engine.mjs';
import { findJpegImages, isReencodable } from '../../src/lib/qpdf/images.ts';
import { bytesToLatin1 } from '../../src/lib/qpdf/bytes.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const report = (...a) => process.stdout.write(a.join(' ') + '\n');

const runner = makeRunner();
const codec = await makeCodec();
const zip = makeZip();

/* Same limit the suite enforces, so "within limit" here means what it means there. */
const LIMIT = { mae: 4, max: 64, over: 6 };

const imagesOf = async (buf) => {
	const flat = await runner(buf, ['--object-streams=disable', '--stream-data=preserve']);
	if (!flat.out) return [];
	return findJpegImages(bytesToLatin1(flat.out)).filter(isReencodable);
};

const unwrap = async (im) => (im.encoding === 'flate-jpeg' ? await zip.inflate(im.data) : im.data);

function compareRasters(a, b) {
	if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: true, mae: Infinity, max: Infinity, over: 100 };
	let sum = 0;
	let max = 0;
	let over = 0;
	for (let i = 0; i < a.width * a.height * 4; i += 4) {
		for (let c = 0; c < 3; c++) {
			const d = Math.abs(a.data[i + c] - b.data[i + c]);
			sum += d;
			if (d > max) max = d;
			if (d > 32) over++;
		}
	}
	const px = a.width * a.height;
	return { sizeMismatch: false, mae: sum / (px * 3), max, over: (over / (px * 3)) * 100 };
}

/** The suite's comparison, reproduced exactly: resize the original to match. */
async function measure(original, candidate) {
	let a = await codec.decode(await unwrap(original));
	if (a.width !== candidate.width || a.height !== candidate.height) {
		a = await codec.resize(a, candidate.width, candidate.height);
	}
	return compareRasters(a, candidate);
}

/* ── damage generators ─────────────────────────────────────────────────────── */

/** A hard luminance ramp across the raster. Cannot be produced by re-encoding. */
function invertPixels(bytes) {
	for (let i = 0; i < bytes.length; i += 4) {
		bytes[i] = 255 - bytes[i];
		bytes[i + 1] = 255 - bytes[i + 1];
		bytes[i + 2] = 255 - bytes[i + 2];
	}
	return 'inverted luminance';
}

/** Block-level scrambling: destroys structure while preserving mean level. */
function scrambleBlocks(bytes, w, h, block = 16) {
	const cols = Math.ceil(w / block);
	const rows = Math.ceil(h / block);

	const blocks = [];
	for (let by = 0; by < rows; by++) {
		for (let bx = 0; bx < cols; bx++) {
			const blk = new Uint8ClampedArray(block * block * 4);
			for (let y = 0; y < block; y++) {
				const sy = by * block + y;
				if (sy >= h) break;
				for (let x = 0; x < block; x++) {
					const sx = bx * block + x;
					if (sx >= w) break;
					const si = (sy * w + sx) * 4;
					const di = (y * block + x) * 4;
					blk[di] = bytes[si];
					blk[di + 1] = bytes[si + 1];
					blk[di + 2] = bytes[si + 2];
					blk[di + 3] = bytes[si + 3];
				}
			}
			blocks.push(blk);
		}
	}

	/* Deterministic shuffle, so a failure is reproducible. */
	let seed = 12345;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	for (let i = blocks.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		const t = blocks[i];
		blocks[i] = blocks[j];
		blocks[j] = t;
	}

	let bi = 0;
	for (let by = 0; by < rows; by++) {
		for (let bx = 0; bx < cols; bx++) {
			const blk = blocks[bi++];
			for (let y = 0; y < block; y++) {
				const dy = by * block + y;
				if (dy >= h) break;
				for (let x = 0; x < block; x++) {
					const dx = bx * block + x;
					if (dx >= w) break;
					const di = (y * block + x) * 4;
					const idx = (dy * w + dx) * 4;
					bytes[idx] = blk[di];
					bytes[idx + 1] = blk[di + 1];
					bytes[idx + 2] = blk[di + 2];
					bytes[idx + 3] = blk[di + 3];
				}
			}
		}
	}
	return `scrambled ${block}px blocks`;
}

/** Shift luminance by a constant: a global exposure error. */
function shiftLuminance(bytes, amount) {
	for (let i = 0; i < bytes.length; i += 4) {
		bytes[i] = Math.min(255, bytes[i] + amount);
		bytes[i + 1] = Math.min(255, bytes[i + 1] + amount);
		bytes[i + 2] = Math.min(255, bytes[i + 2] + amount);
	}
	return `luminance shifted +${amount}`;
}

const CASES = [
	{ name: 'invert', damage: invertPixels },
	{ name: 'scramble', damage: scrambleBlocks },
	{ name: 'shift+40', damage: (b) => shiftLuminance(b, 40) }
];

/* ── run ───────────────────────────────────────────────────────────────────── */

report('');
report('Fidelity negative control - does the resized comparison actually detect damage?');
report('');
report('A control is only meaningful if the UNDAMAGED resized comparison already');
report('sits inside the limits. Otherwise the case proves nothing.');
report('');

const CASES_FILES = ['scan-300dpi-q80.pdf', 'oversized-600dpi.pdf', 'photo-q35.pdf', 'graphic-q75.pdf'];

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

for (const file of CASES_FILES) {
	const bytes = new Uint8Array(await readFile(path.join(here, '..', 'fixtures', file)));
	const before = await imagesOf(bytes);
	if (!before.length) continue;

	const res = await optimize({ bytes, mode: 'maximum', zip }, runner, codec);
	const after = await imagesOf(res.bytes);
	if (!after.length) {
		report(`  ${file}: no output image, skipping`);
		continue;
	}

	const img = after[0];
	const original =
		before.find((b) => b.width === img.width && b.height === img.height) ??
		[...before].sort(
			(x, y) => Math.abs(x.width / x.height - img.width / img.height) - Math.abs(y.width / y.height - img.width / img.height)
		)[0];

	/* Only meaningful for a fixture that is actually downscaled in this mode. */
	const downscaled = !(original.width === img.width && original.height === img.height);
	report(`  ${file}  ${original.width}x${original.height} -> ${img.width}x${img.height}${downscaled ? '  (downscaled)' : '  (NOT downscaled - cannot exercise this path)'}`);
	if (!downscaled) continue;

	/* Decode the candidate once; damage is applied to its pixels, never to the
	 * JPEG payload, so the control cannot be dismissed as "invalid JPEG". */
	const clean = await codec.decode(await unwrap(img));
	const baseline = await measure(original, clean);

	for (const c of CASES) {
		const damaged = new Uint8ClampedArray(clean.data);
		const how = c.damage(damaged, clean.width, clean.height);
		const damagedResult = await measure(original, new ImageData(damaged, clean.width, clean.height));

		const baseClean = baseline.mae <= LIMIT.mae && baseline.max <= LIMIT.max && baseline.over <= LIMIT.over;
		const caught = damagedResult.mae > LIMIT.mae || damagedResult.max > LIMIT.max || damagedResult.over > LIMIT.over;

		if (!baseClean) {
			skipped++;
			report(
				`    ${c.name.padEnd(10)} baseline mae ${baseline.mae.toFixed(2)} max ${baseline.max} over ${baseline.over.toFixed(2)}%` +
					` - ALREADY OUTSIDE LIMITS, cannot validate detection on this fixture`
			);
			continue;
		}

		if (caught) {
			passed++;
			report(
				`    ${c.name.padEnd(10)} baseline mae ${baseline.mae.toFixed(2).padStart(5)} -> ${damagedResult.mae.toFixed(2).padStart(7)}  ` +
					`DETECTED (${how})`
			);
		} else {
			failed++;
			failures.push(`${file}/${c.name}: damage of ${how} left mae at ${damagedResult.mae.toFixed(2)}, inside limits`);
			report(`    ${c.name.padEnd(10)} baseline mae ${baseline.mae.toFixed(2).padStart(5)} -> ${damagedResult.mae.toFixed(2).padStart(7)}  NOT DETECTED (${how})`);
		}
	}
	report('');
}

report(`${passed} controls detected the damage, ${failed} did not, ${skipped} skipped (baseline already outside limits)`);
if (failures.length) {
	report('');
	for (const f of failures) report(`  - ${f}`);
}
report('');

process.exit(failed ? 1 : 0);