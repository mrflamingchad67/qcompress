/**
 * Deterministic PDF fixtures for testing the WASM engine.
 *
 * Everything is generated in-process so tests are reproducible and no user
 * files are touched.
 */

import zlib from 'node:zlib';

const enc = (s) => Buffer.from(s, 'latin1');

function zlibFlate(text) {
	return new Uint8Array(zlib.deflateSync(enc(text)));
}

/**
 * Build a PDF from a list of objects, computing stream /Length and xref
 * offsets correctly.
 *
 * @param {Array<{dict: string, stream?: string|Uint8Array|null}>} objects
 * @param {{header?: string, info?: string, extraTrailer?: string}} [opts]
 */
export function build(objects, { header = '%PDF-1.7', info = null, extraTrailer = '' } = {}) {
	const chunks = [];
	let pos = 0;
	const push = (buf) => {
		const b = buf instanceof Uint8Array ? buf : enc(buf);
		chunks.push(b);
		pos += b.length;
	};

	push(header + '\n%\xE2\xE3\xCF\xD3\n');

	// The trailer needs /Info's object number, so it is allocated after the
	// caller-supplied objects.
	const infoNum = info ? objects.length + 1 : null;
	if (infoNum) objects = [...objects, { dict: info }];

	const offsets = [];
	objects.forEach((obj, i) => {
		offsets.push(pos);
		const num = i + 1;
		if (obj.stream === undefined || obj.stream === null) {
			push(`${num} 0 obj\n${obj.dict}\nendobj\n`);
		} else {
			const body = typeof obj.stream === 'string' ? enc(obj.stream) : obj.stream;
			let dict = obj.dict;
			if (/\/Length\s+/.test(dict)) {
				dict = dict.replace(/\/Length\s+\d+/, `/Length ${body.length}`);
			} else {
				dict = dict.replace(/\s*>>\s*$/, ` /Length ${body.length} >>`).replace(/^<<\s*/, '<< ');
			}
			push(`${num} 0 obj\n${dict}\nstream\n`);
			push(body);
			push('\nendstream\nendobj\n');
		}
	});

	const xrefPos = pos;
	const n = objects.length + 1;
	let xref = `xref\n0 ${n}\n0000000000 65535 f \n`;
	for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
	push(xref);
	push(
		`trailer\n<< /Size ${n} /Root 1 0 R${infoNum ? ` /Info ${infoNum} 0 R` : ''}${extraTrailer} >>\n` +
			`startxref\n${xrefPos}\n%%EOF\n`
	);

	const total = chunks.reduce((a, b) => a + b.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

const textContent = (lines) =>
	`BT\n/F1 11 Tf\n1 0 0 1 56 760 Tm\n14 TL\n${lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n')}\nET\n`;

/**
 * Object layout shared by the multipage generators:
 *   1          Catalog
 *   2          Pages
 *   3 + 2p     Page   (p = 0..pages-1)
 *   4 + 2p     Contents stream for page p
 *   3 + 2*n    Font
 */
const pageObjNum = (p) => 3 + p * 2;
const contentObjNum = (p) => 4 + p * 2;
const fontObjNum = (pages) => 3 + pages * 2;

const pageDict = (p, pages, extra = '') =>
	`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
	`/Resources << /Font << /F1 ${fontObjNum(pages)} 0 R >> >> ` +
	`/Contents ${contentObjNum(p)} 0 R ${extra}>>`;

const kidsArray = (pages) =>
	Array.from({ length: pages }, (_, p) => `${pageObjNum(p)} 0 R`).join(' ');

const fontDict = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

/** Text-heavy, multi-page, uncompressed content streams. */
export function textPdf(pages = 8, linesPerPage = 45) {
	const objs = [
		{ dict: '<< /Type /Catalog /Pages 2 0 R >>' },
		{ dict: `<< /Type /Pages /Kids [${kidsArray(pages)}] /Count ${pages} >>` }
	];
	for (let p = 0; p < pages; p++) {
		const lines = Array.from(
			{ length: linesPerPage },
			(_, i) => `Page ${p + 1} line ${i + 1}: the quick brown fox jumps over the lazy dog 0123456789`
		);
		objs.push({ dict: pageDict(p, pages) });
		objs.push({ dict: '<< >>', stream: textContent(lines) });
	}
	objs.push({ dict: fontDict });
	return build(objs);
}

/** Single tiny page, used for smoke tests. */
export function minimalPdf() {
	return build([
		{ dict: '<< /Type /Catalog /Pages 2 0 R >>' },
		{ dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
		{
			dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
		},
		{ dict: '<< >>', stream: 'BT /F1 12 Tf 20 100 Td (Hello PDF) Tj ET\n' },
		{ dict: fontDict }
	]);
}

/** Already-optimized: Flate-compressed content streams. */
export function alreadyCompressedPdf(pages = 6) {
	const objs = [
		{ dict: '<< /Type /Catalog /Pages 2 0 R >>' },
		{ dict: `<< /Type /Pages /Kids [${kidsArray(pages)}] /Count ${pages} >>` }
	];
	for (let p = 0; p < pages; p++) {
		objs.push({ dict: pageDict(p, pages) });
		objs.push({
			dict: '<< /Filter /FlateDecode >>',
			stream: zlibFlate(
				textContent(
					Array.from({ length: 45 }, (_, i) => `Compressed page ${p + 1} line ${i + 1} aaa bbb ccc ddd eee`)
				)
			)
		});
	}
	objs.push({ dict: fontDict });
	return build(objs, { header: '%PDF-1.5' });
}

/** A file that is not a PDF at all. */
export function notAPdf() {
	return new Uint8Array(enc('This is plainly not a PDF document.\n'));
}

/**
 * Image-heavy: each page embeds a large FlateDecode RGB image.
 *
 * Raw RGB bytes are near-random below so they survive Flate and stay large,
 * which is what makes this a useful "image heavy" counterpart to textPdf().
 */
export function imagePdf(pages = 4, w = 600, h = 800) {
	// Deterministic pseudo-random RGB data (xorshift) so builds are stable.
	let seed = 0x9e3779b9;
	const raw = Buffer.alloc(w * h * 3);
	for (let i = 0; i < raw.length; i++) {
		seed ^= seed << 13; seed >>>= 0;
		seed ^= seed >> 17;
		seed ^= seed << 5; seed >>>= 0;
		raw[i] = seed & 0xff;
	}
	const img = new Uint8Array(zlib.deflateSync(raw, { level: 6 }));
	const imgNum = 3 + pages * 2;

	const objs = [
		{ dict: '<< /Type /Catalog /Pages 2 0 R >>' },
		{ dict: `<< /Type /Pages /Kids [${kidsArray(pages)}] /Count ${pages} >>` }
	];
	for (let p = 0; p < pages; p++) {
		const contentNum = contentObjNum(p);
		objs.push({
			dict:
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
				`/Resources << /XObject << /Im0 ${imgNum} 0 R >> >> ` +
				`/Contents ${contentNum} 0 R >>`
		});
		objs.push({
			dict: '<< >>',
			stream: `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q\n`
		});
	}
	objs.push({
		dict:
			`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
			'/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode >>',
		stream: img
	});
	return build(objs, { header: '%PDF-1.5' });
}