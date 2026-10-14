/**
 * Cross-reference table rebuilding.
 *
 * Replacing an image stream changes its length, which invalidates every
 * absolute byte offset recorded in the cross-reference table. QPDF refuses to
 * read such a file (and refuses to repair it), so the table has to be rebuilt
 * before the document can be validated or re-opened by anything.
 *
 * Only single-revision documents are handled. Incremental-update files have
 * more than one `startxref`, and silently collapsing those would lose content,
 * so we bail out and let the caller fall back to structural-only output.
 */

/** One object and where it starts. */
interface ObjRef {
	num: number;
	offset: number;
}

/**
 * Walk the file and locate every `N 0 obj`.
 *
 * Sequential rather than regex-based: a regex would happily match the bytes
 * "3 0 obj" inside a binary stream. Here we skip declared stream payloads
 * using their /Length, so a match is always a real object header.
 */
export function scanObjects(text: string, from = 0, to = text.length): ObjRef[] {
	const objects: ObjRef[] = [];
	let pos = from;

	while (pos < to) {
		const m = /(?:^|[\s>\]])(\d+)\s+0\s+obj\b/.exec(text.slice(pos, to));
		if (!m) break;

		const num = parseInt(m[1], 10);
		// m[0] may start with a one-character delimiter (whitespace, '>' or
		// ']') before the object number, or directly with the number at the
		// very start of the slice. The offset must point at the first digit.
		const delimLen = m[0][0] >= '0' && m[0][0] <= '9' ? 0 : 1;
		const offset = pos + m.index + delimLen;
		objects.push({ num, offset });

		// Skip past this object's payload.
		const bodyStart = pos + m.index + m[0].length;
		const endIdx = findEndObj(text, bodyStart, to);
		pos = endIdx === -1 ? bodyStart : endIdx + 6; // past "endobj"
	}

	return objects;
}

/**
 * Find `endobj` for the object starting at `bodyStart`, skipping stream data.
 */
function findEndObj(text: string, bodyStart: number, limit: number): number {
	const streamIdx = text.indexOf('stream', bodyStart);
	const endObjIdx = text.indexOf('endobj', bodyStart);

	if (streamIdx === -1 || (endObjIdx !== -1 && endObjIdx < streamIdx)) {
		return endObjIdx;
	}

	// There is a stream: read /Length from the dict immediately before it.
	const dictStart = text.lastIndexOf('<<', streamIdx);
	let dataStart = streamIdx + 'stream'.length;
	if (text[dataStart] === '\r') dataStart++;
	if (text[dataStart] === '\n') dataStart++;

	let skip = -1;
	if (dictStart !== -1) {
		const lenMatch = /\/Length\s+(\d+)/.exec(text.slice(dictStart, streamIdx));
		if (lenMatch) {
			const declared = parseInt(lenMatch[1], 10);
			// Trust the declared length only if `endstream` really follows it.
			const after = text.indexOf('endstream', dataStart + declared);
			const between = text.slice(dataStart + declared, after === -1 ? dataStart : after);
			if (after !== -1 && between.trim().length <= 2) skip = declared;
		}
	}
	if (skip === -1) {
		// Fall back to searching for the keyword.
		const after = text.indexOf('endstream', dataStart);
		skip = after === -1 ? 0 : after - dataStart;
	}

	return text.indexOf('endobj', dataStart + skip);
}

/** Render a classic cross-reference table. */
export function renderXref(objects: ObjRef[], size: number): string {
	const byNum = new Map<number, number>();
	for (const o of objects) if (!byNum.has(o.num)) byNum.set(o.num, o.offset);

	// Group into contiguous runs, as the spec expects.
	const nums = [...byNum.keys()].sort((a, b) => a - b);
	const groups: number[][] = [];
	for (const n of nums) {
		const last = groups[groups.length - 1];
		if (last && n === last[last.length - 1] + 1) last.push(n);
		else groups.push([n]);
	}

	let out = 'xref\n';
	for (const g of groups) {
		out += `${g[0]} ${g.length}\n`;
		for (const n of g) {
			// Object 0 (and any number we never saw) is a free entry.
			if (!byNum.has(n)) out += '0000000000 65535 f \n';
			else out += `${String(byNum.get(n)).padStart(10, '0')} 00000 n \n`;
		}
	}
	return out;
}

/**
 * Rebuild the xref of a single-revision PDF, preserving its trailer.
 *
 * Returns null when the document has more than one revision, or when the
 * existing layout is not the classic `xref ... trailer ... startxref` form.
 */
export function rebuildXref(text: string): string | null {
	const starts = [...text.matchAll(/\bstartxref\s+(\d+)/g)];
	if (starts.length !== 1) return null;

	const startxrefIdx = starts[0].index!;

	// The recorded offset is stale by definition after a splice, so locate the
	// table positionally: it is the last `xref` keyword before `trailer`.
	const trailerIdx = text.lastIndexOf('trailer', startxrefIdx);
	if (trailerIdx === -1) return null;

	let xrefPos = -1;
	for (let i = trailerIdx - 1; i >= 0; i--) {
		if (text.startsWith('xref', i)) {
			const before = i === 0 ? '\n' : text[i - 1];
			const after = text[i + 4] ?? '\n';
			if (/\s/.test(before) && /\s/.test(after)) {
				xrefPos = i;
				break;
			}
		}
	}
	if (xrefPos === -1) return null;

	// The trailer dictionary, verbatim.
	let trailerDict = text.slice(trailerIdx + 'trailer'.length, startxrefIdx).trim();

	const objects = scanObjects(text, 0, xrefPos);
	if (!objects.length) return null;

	const maxNum = objects.reduce((a, o) => Math.max(a, o.num), 0);
	const declaredSize = /\/Size\s+(\d+)/.exec(trailerDict);
	const size = Math.max(maxNum + 1, declaredSize ? parseInt(declaredSize[1], 10) : 0);

	if (declaredSize) trailerDict = trailerDict.replace(/\/Size\s+\d+/, `/Size ${size}`);
	else trailerDict = trailerDict.replace(/^<<\s*/, `<< /Size ${size} `);

	// Everything before the table is untouched; the table is replaced in place
	// so its start offset does not move.
	const head = text.slice(0, xrefPos);
	const newXrefPos = head.length;

	return `${head}${renderXref(objects, size)}trailer\n${trailerDict}\nstartxref\n${newXrefPos}\n%%EOF\n`;
}