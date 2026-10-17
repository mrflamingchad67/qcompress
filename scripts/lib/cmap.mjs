/**
 * /ToUnicode CMap parsing.
 *
 * WHY THIS EXISTS
 *
 * The text suite compares the bytes a page hands to Tj / TJ / ' / ". For a
 * Type0 font with /Identity-H encoding those bytes are CIDs - glyph indices,
 * not characters. `0048` is only an "H" because the font's /ToUnicode CMap says
 * so. So the existing suite proves the glyph indices survived and says nothing
 * about whether they still mean anything. A compressor that destroyed every
 * CMap would pass every check in the repository.
 *
 * This parses the CMap so that gap can be closed.
 *
 * WHAT IS PARSED
 *
 *   begincodespacerange  how many bytes a source code is, per font. Without
 *                        this a 1-byte font and a 2-byte font are
 *                        indistinguishable, and a CMap that maps <41> cannot be
 *                        read correctly if the caller assumes two bytes.
 *   beginbfchar          <src> <dst>            one code to one target
 *   beginbfrange         <lo> <hi> <dst>        a run sharing one target
 *                        <lo> <hi> [<d1> <d2>]  a run with a target array
 *
 * The array form must be consumed before the scalar form: `<lo> <hi> <dst>`
 * also matches the opening of `<lo> <hi> [ ... ]` if the parser is careless,
 * and a CMap containing both will silently lose one of them.
 *
 * Targets are UTF-16BE, so surrogate pairs are recombined on decode.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not judge whether the document's mapping is CORRECT. A wrong CMap in
 * the source stays wrong; this can only prove that compression did not change
 * it. Claiming more would be a stronger guarantee than the work supports.
 */

/**
 * @typedef {Object} CMap
 * @property {Map<string,string>} toUnicode   source hex -> target hex (uppercase)
 * @property {Array<{lo:number,hi:number,bytes:number}>} codeSpaces  byte length per range
 * @property {number} bfcharCount
 * @property {number} bfrangeCount
 */

/** Byte lengths a source code can have, as declared by codespacerange. */
function parseCodeSpaces(body) {
	const spaces = [];
	for (const block of body.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
		for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
			const bytes = m[1].length / 2;
			if (bytes > 0) spaces.push({ lo: parseInt(m[1], 16), hi: parseInt(m[2], 16), bytes });
		}
	}
	return spaces;
}

/** Expand one bfchar/bfrange block into source -> target pairs. */
function parseBlock(body) {
	const pairs = new Map();
	let bfcharCount = 0;
	let bfrangeCount = 0;

	for (const block of body.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
		for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
			pairs.set(m[1].toUpperCase(), m[2].toUpperCase());
			bfcharCount++;
		}
	}

	for (const block of body.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
		const inner = block[1];

		/* Codes claimed by an ARRAY range. Without this the scalar pattern
		 * below matches inside the array's target list -
		 * `<0041> <0045> [<0041> <0042> <0043> ...]` contains
		 * `<0041> <0042> <0043>` - and overwrites the array's own mappings with
		 * a scalar run's, so 0041 decodes as 'C' instead of 'A'. Consuming the
		 * array first is not enough; the scalar pass must also stand aside. */
		const claimed = new Set();

		for (const m of inner.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g)) {
			const loHex = m[1].toUpperCase();
			const lo = parseInt(loHex, 16);
			const hi = parseInt(m[2], 16);
			const targets = [...m[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1].toUpperCase());
			// A run wider than its target list is malformed; cap rather than loop
			// to a bogus bound from untrusted input.
			const span = Math.min(hi - lo + 1, targets.length, 65536);
			for (let i = 0; i < span; i++) {
				const key = (lo + i).toString(16).toUpperCase().padStart(loHex.length, '0');
				pairs.set(key, targets[i]);
				claimed.add(key);
				bfrangeCount++;
			}
		}

		for (const m of inner.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
			// A scalar range whose first code an array already claimed is a
			// match inside that array's target list, not a real range.
			if (claimed.has(m[1].toUpperCase())) continue;
			const loHex = m[1].toUpperCase();
			const lo = parseInt(loHex, 16);
			const hi = parseInt(m[2], 16);
			const dstHex = m[3].toUpperCase();
			const dstValue = parseInt(dstHex, 16);

			/* Per ISO 32000-1 9.7.6.3 the DESTINATION increments across the run,
			 * not the source: <0020> <0024> <0061> maps 0020->0061, 0021->0062
			 * and so on. The increment carries over the destination's low bytes,
			 * wrapping within the destination's own width. */
			const span = Math.min(hi - lo + 1, 65536);
			for (let i = 0; i < span; i++) {
				const src = (lo + i).toString(16).toUpperCase().padStart(loHex.length, '0');
				let out = (dstValue + i).toString(16).toUpperCase();
				// A run that overflows the destination width wraps rather than
				// growing a character that was never in the CMap.
				if (out.length > dstHex.length) out = out.slice(-dstHex.length);
				pairs.set(src, out.padStart(dstHex.length, '0'));
				bfrangeCount++;
			}
		}
	}

	return { pairs, bfcharCount, bfrangeCount };
}

/**
 * Parse a decoded /ToUnicode CMap stream.
 *
 * @param {string} body the CMap source, already inflated
 * @returns {CMap}
 */
export function parseCMap(body) {
	const source = typeof body === 'string' ? body : Buffer.from(body).toString('latin1');
	const codeSpaces = parseCodeSpaces(source);
	const { pairs, bfcharCount, bfrangeCount } = parseBlock(source);
	return { toUnicode: pairs, codeSpaces, bfcharCount, bfrangeCount };
}

/**
 * Split a PDF string into CIDs using the CMap's declared code-space byte
 * lengths.
 *
 * Returns null when the code space cannot be determined, because guessing would
 * silently produce wrong text - and wrong text that still compares equal to
 * itself is exactly the failure this module exists to prevent.
 *
 * @param {Uint8Array|string} bytes
 * @param {CMap} cmap
 * @returns {string[]|null} source codes as uppercase hex
 */
export function splitIntoCodes(bytes, cmap) {
	const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : Buffer.from(bytes);
	if (!cmap.codeSpaces.length) return null;

	const out = [];
	let i = 0;
	while (i < buf.length) {
		let matched = false;
		for (const cs of cmap.codeSpaces) {
			const len = cs.bytes;
			if (i + len > buf.length) continue;
			let code = 0;
			for (let k = 0; k < len; k++) code = code * 256 + buf[i + k];
			if (code < cs.lo || code > cs.hi) continue;
			out.push(buf.subarray(i, i + len).toString('hex').toUpperCase());
			i += len;
			matched = true;
			break;
		}
		if (!matched) {
			// An unmappable byte: consume it rather than looping forever, and say
			// so by returning what was decoded so far alongside the gap marker.
			out.push(null);
			i++;
		}
	}
	return out;
}

/** UTF-16BE hex -> a JS string, recombining surrogate pairs. */
export function utf16beToString(hex) {
	if (!hex) return '';
	/* A target is normally a whole number of UTF-16 code units. A truncated one
	 * is left-padded with zeros rather than dropped: returning "" would silently
	 * shorten text, and padding on the right would turn `<0041>` truncated to
	 * `<004>` into U+0040 instead of the U+0004 the value actually denotes. */
	const padded = hex.length % 4 === 0 ? hex : hex.padStart(Math.ceil(hex.length / 4) * 4, '0');
	let s = '';
	for (let i = 0; i + 4 <= padded.length; i += 4) {
		s += String.fromCharCode(parseInt(padded.slice(i, i + 4), 16));
	}
	return s;
}

/** A Map of source hex -> Unicode string, for comparing CMap contents. */
export function toUnicodeMap(cmap) {
	const out = new Map();
	for (const [src, dst] of cmap.toUnicode) out.set(src, utf16beToString(dst));
	return out;
}

/**
 * Order-independent digest of everything that affects what characters a string
 * decodes to.
 *
 * The code space is included deliberately. It decides how many bytes make up
 * each source code, so a document whose codespacerange changed extracts
 * completely different text from an IDENTICAL mapping table. Fingerprinting only
 * `toUnicode` would let that pass - which is what the negative control caught.
 */
export function fingerprint(cmap) {
	const mappings = [...cmap.toUnicode.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([k, v]) => `${k}=${v}`)
		.join(',');
	const spaces = [...cmap.codeSpaces]
		.map((c) => `${c.bytes}:${c.lo}-${c.hi}`)
		.sort()
		.join(',');
	return `cs[${spaces}]map[${mappings}]`;
}