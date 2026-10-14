/**
 * A PDF builder with symbolic object references.
 *
 * Hand-numbering objects (`/Annots [8 0 R]` while the widget is really object
 * 6) produces documents with dangling references that still parse, and the
 * dangling reference is invisible until something tries to follow it. Writing
 * `/Annots [${link}]` instead makes the document correct by construction and
 * keeps it correct when objects are added or removed.
 */
import { writeFile } from 'node:fs/promises';

/**
 * @param {Array<{name?: string, dict: string, stream?: string|Uint8Array}>} items
 * @param {{header?: string, info?: string, extraTrailer?: string, catalogName?: string}} [opts]
 */
export function buildNamed(items, opts = {}) {
	const { header = '%PDF-1.5', info = null, extraTrailer = '' } = opts;

	const enc = (s) => Buffer.from(s, 'latin1');

	// Assign numbers, then resolve `${name}` everywhere.
	const numberOf = new Map();
	items.forEach((it, i) => {
		if (it.name) numberOf.set(it.name, i + 1);
	});

	const resolve = (s) =>
		typeof s === 'string' ? s.replace(/\$\{(\w+)\}/g, (_, n) => String(numberOf.get(n) ?? 0)) : s;

	const infoNum = info ? items.length + 1 : null;
	const numbered = [
		...items.map((it) => ({ ...it, dict: resolve(it.dict), stream: resolve(it.stream) })),
		...(info ? [{ dict: info }] : [])
	];

	const chunks = [];
	let pos = 0;
	const push = (buf) => {
		const b = Buffer.isBuffer(buf) ? buf : enc(buf);
		chunks.push(b);
		pos += b.length;
	};

	push(header + '\n%\xE2\xE3\xCF\xD3\n');

	const offsets = [];
	numbered.forEach((o, i) => {
		offsets.push(pos);
		const num = i + 1;
		if (o.stream === undefined || o.stream === null) {
			push(`${num} 0 obj\n${o.dict}\nendobj\n`);
		} else {
			const body = Buffer.isBuffer(o.stream) ? o.stream : enc(o.stream);
			let dict = o.dict;
			dict = /\/Length\s+\d+/.test(dict)
				? dict.replace(/\/Length\s+\d+/, `/Length ${body.length}`)
				: dict.replace(/\s*>>\s*$/, ` /Length ${body.length} >>`).replace(/^<<\s*/, '<< ');
			push(`${num} 0 obj\n${dict}\nstream\n`);
			push(body);
			push('\nendstream\nendobj\n');
		}
	});

	const xrefPos = pos;
	const n = numbered.length + 1;
	let xref = `xref\n0 ${n}\n0000000000 65535 f \n`;
	for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
	push(xref);

	const rootName = opts.catalogName;
	const rootNum = rootName ? numberOf.get(rootName) ?? 1 : 1;
	push(
		`trailer\n<< /Size ${n} /Root ${rootNum} 0 R${infoNum ? ` /Info ${infoNum} 0 R` : ''}${extraTrailer} >>\n` +
			`startxref\n${xrefPos}\n%%EOF\n`
	);

	return Buffer.concat(chunks);
}

export { writeFile };