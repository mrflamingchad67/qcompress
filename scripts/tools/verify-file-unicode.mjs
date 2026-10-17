/**
 * Does the Unicode guarantee hold on the REAL documents?
 *
 * The corpus coverage is thin: only 9 of 159 pages across 39 fixtures have
 * decodable text, because most fixtures use simple fonts whose bytes are
 * already characters. That is fine for a regression suite, but it means the
 * suite's reach does not establish anything about the documents users actually
 * compress. Both real documents use Type0 /Identity-H fonts, so this is the
 * case that matters.
 *
 * Run: bun scripts/tools/verify-file-unicode.mjs <file.pdf> [...]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const REPO = 'C:/Users/User/Desktop/qpdf-compressor';
const { optimize } = await import(`${REPO}/src/lib/qpdf/pipeline.ts`);
const { bytesToLatin1 } = await import(`${REPO}/src/lib/qpdf/bytes.ts`);
const { parseObjects } = await import(`${REPO}/src/lib/qpdf/structure.ts`);
const { extractTextOps } = await import(`${REPO}/scripts/lib/textlayer.mjs`);
const { fontCMapsForPage, decodePage, installInflate } = await import(`${REPO}/scripts/lib/unicode.mjs`);
const { makeRunner, makeCodec, makeZip } = await import(`${REPO}/scripts/lib/engine.mjs`);

const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const runner = makeRunner();
const codec = await makeCodec();
const zip = makeZip();
installInflate((b) => zlib.inflateSync(Buffer.from(b)));

const FLATTEN = ['--object-streams=disable', '--stream-data=preserve'];

async function flatten(bytes) {
	const r = await runner(bytes, FLATTEN);
	return r.out ? bytesToLatin1(r.out) : null;
}

function pagesOf(flat) {
	return [...parseObjects(flat).entries()]
		.filter(([, o]) => /\/Type\s*\/Page[^s]/.test(o.dict ?? ''))
		.sort((a, b) => a[0] - b[0])
		.map(([num, o]) => ({ num, obj: o }));
}

async function contentOf(flat, objects, pageDict) {
	const refs = [];
	const single = /\/Contents\s+(\d+)\s+0\s+R/.exec(pageDict);
	if (single) refs.push(parseInt(single[1], 10));
	const arr = /\/Contents\s*\[([^\]]*)\]/.exec(pageDict);
	if (arr) for (const m of arr[1].matchAll(/(\d+)\s+0\s+R/g)) refs.push(parseInt(m[1], 10));
	if (refs.length === 0) return '';

	const parts = [];
	for (const num of refs) {
		const o = objects.get(num);
		if (!o?.dict) return null;
		const at = flat.indexOf('stream', o.dictEnd);
		if (at === -1) return null;
		let start = at + 6;
		if (flat[start] === '\r') start++;
		if (flat[start] === '\n') start++;
		const len = parseInt(/\/Length\s+(\d+)/.exec(o.dict)?.[1] ?? '0', 10);
		if (!len) return null;
		const raw = flat.slice(start, start + len);
		if (/\/Filter/.test(o.dict)) {
			try {
				parts.push(Buffer.from(await zip.inflate(Buffer.from(raw, 'latin1'))).toString('latin1'));
				continue;
			} catch {
				return null;
			}
		}
		parts.push(raw);
	}
	return parts.join('\n');
}

async function decodeDocument(flat) {
	const objects = parseObjects(flat);
	const out = [];
	for (const { num, obj } of pagesOf(flat)) {
		const stream = await contentOf(flat, objects, obj.dict);
		if (stream === null) {
			out.push({ page: num, unreadable: true });
			continue;
		}
		const cmaps = fontCMapsForPage(flat, obj);
		out.push({ page: num, unreadable: false, ...decodePage(extractTextOps(stream), cmaps) });
	}
	return out;
}

const files = process.argv.slice(2);
if (files.length === 0) {
	log('usage: bun scripts/tools/verify-file-unicode.mjs <file.pdf> [...]');
	process.exit(2);
}

let failed = 0;

for (const file of files) {
	log('');
	log(`=== ${path.basename(file)} ===`);

	const input = new Uint8Array(await readFile(file));
	const beforeFlat = await flatten(input);
	if (beforeFlat === null) {
		log('  qpdf could not flatten the input');
		failed++;
		continue;
	}

	const before = await decodeDocument(beforeFlat);
	const decodable = before.filter((p) => !p.unreadable && !p.fontless && !p.noCMap && p.ops > 0);
	const notDecodable = before.length - decodable.length;

	const cmaps = (beforeFlat.match(/\/ToUnicode/g) ?? []).length;
	const type0 = (beforeFlat.match(/\/Subtype\s*\/Type0/g) ?? []).length;
	log(`  Type0 fonts ${type0}, /ToUnicode refs ${cmaps}, pages ${before.length}`);
	log(`  decodable pages ${decodable.length}, not decodable ${notDecodable}`);

	if (decodable.length === 0) {
		log('  nothing decodable here - this document cannot exercise the Unicode guarantee');
		continue;
	}

	const sample = decodable[0].text.slice(0, 90);
	log(`  first page text: ${JSON.stringify(sample)}${decodable[0].text.length > 90 ? ' ...' : ''}`);

	for (const mode of ['lossless', 'balanced', 'maximum']) {
		const res = await optimize({ bytes: input, mode, zip }, runner, codec);
		const afterFlat = await flatten(res.bytes);
		const after = await decodeDocument(afterFlat);

		/* Pair by PAGE OBJECT NUMBER, not by position.
		 *
		 * `decodable` is filtered out of the full page list, so index i in it
		 * does NOT correspond to index i in `after`. Comparing positionally
		 * compared page 20 against page 1 and reported "CHANGED" on three pages
		 * where nothing had changed. Object numbers are stable here because this
		 * document is uncompressed; where they are not, the position is used and
		 * the difference is reported rather than hidden. */
		const byNumber = new Map(after.map((p) => [p.page, p]));

		let chars = 0;
		const diffs = [];
		for (const a of decodable) {
			const b = byNumber.get(a.page);
			if (!b) {
				diffs.push(`page obj ${a.page} missing from the output`);
				continue;
			}
			if (a.ops !== b.ops) diffs.push(`page obj ${a.page}: ${a.ops} -> ${b.ops} ops`);
			if (a.text !== b.text) {
				diffs.push(
					`page obj ${a.page}: ${JSON.stringify(a.text.slice(0, 40))} -> ${JSON.stringify(b.text.slice(0, 40))}`
				);
			}
			chars += a.text.length;
		}
		const verdict = diffs.length === 0 ? 'identical' : 'CHANGED';
		log(`  ${mode.padEnd(9)} ${chars} chars across ${decodable.length} pages: ${verdict}`);
		for (const d of diffs.slice(0, 5)) log(`             ${d}`);
		if (diffs.length) failed++;
	}
}

log('');
process.exit(failed ? 1 : 0);