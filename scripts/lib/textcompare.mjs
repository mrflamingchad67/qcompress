/**
 * Comparing two text signatures.
 *
 * Separate from the extractor so the comparison rule is one readable thing, and
 * so a failure points at either "the stream was parsed differently" or "the text
 * changed" rather than at a stack trace through both.
 *
 * THE EQUALITY RULE
 *
 * Two pages match when BOTH of these hold:
 *
 *   1. Byte equality. The concatenation of every string operand, in order, is
 *      identical. This is the invariant - it is what "the page says the same
 *      thing" means, independent of how the producer chose to chunk its output.
 *
 *   2. Segment equality. The same holds per text-showing operation, with `TJ`
 *      arrays compared segment by segment.
 *
 * Both are required, and the rule was fixed BEFORE the corpus was run, because
 * changing it after seeing a fixture fail would be fitting the test to the
 * output. Requiring both is defensible here for a specific reason: QCompress
 * documents that it never rewrites content streams, so re-segmentation is not
 * something this compressor does. A difference in rule 2 with rule 1 holding
 * would be a genuine finding, not a cosmetic one, and is reported as such
 * rather than waved through.
 *
 * Comparison is direct, never by hash. A stable digest would be a legitimate
 * optimisation on a large corpus, but at this size it would only make failures
 * harder to read, and "the hashes matched" is weaker evidence than "the bytes
 * matched".
 *
 * NO SILENT EMPTINESS
 *
 * A page that could not be parsed is reported as unsupported, never as "no
 * text". An original page WITH text whose candidate yields no text is a
 * failure, and an original page with no text whose candidate also has no text
 * is a pass - that is a legitimate image-only or blank page, not a defect.
 */

const ESC = (s) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

/**
 * A short, bounded, printable rendering of extracted bytes.
 *
 * These bytes are font-encoded, not UTF-8, so this is explicitly NOT a text
 * preview and must not be read as one. It exists to make a diff legible, and is
 * truncated so a failure cannot dump a document into CI logs.
 */
export function preview(bytes, limit = 60) {
	const shown = bytes.subarray(0, limit);
	let out = '';
	for (const b of shown) {
		// Printable ASCII only; anything else is shown as a placeholder so
		// multi-byte font encodings cannot corrupt a log line.
		out += b >= 0x20 && b <= 0x7e ? ESC(String.fromCharCode(b)) : '\\x' + b.toString(16).padStart(2, '0');
	}
	return bytes.length > limit ? `${out}...(+${bytes.length - limit}B)` : out;
}

function equalBytes(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * Compare one page.
 *
 * @returns {{ok: boolean, problems: Array<object>}}
 */
export function comparePage(before, after) {
	const problems = [];

	/* An unreadable stream is unknown, not empty. */
	if (after.unsupported && !before.unsupported) {
		problems.push({
			kind: 'unreadable-candidate',
			detail: `candidate stream could not be read: ${after.unsupported}`
		});
		return { ok: false, problems };
	}
	if (before.unsupported || after.unsupported) {
		// Both unreadable: there is nothing to compare, and that is not a
		// success. The caller decides how loudly to fail.
		if (before.unsupported || after.unsupported) {
			problems.push({
				kind: 'unreadable',
				detail: `before: ${before.unsupported ?? 'ok'} / after: ${after.unsupported ?? 'ok'}`
			});
		}
		return { ok: false, problems };
	}

	/* Rule 1: the ordered byte sequence. */
	if (!equalBytes(before.text, after.text)) {
		problems.push({
			kind: 'text-bytes',
			expectedBytes: before.text.length,
			actualBytes: after.text.length,
			expected: preview(before.text),
			actual: preview(after.text),
			detail: describeFirstByteDifference(before.text, after.text)
		});
	}

	/* Rule 2: operator and segment boundaries. */
	if (before.ops.length !== after.ops.length) {
		problems.push({
			kind: 'op-count',
			expected: before.ops.length,
			actual: after.ops.length,
			detail: `expected ${before.ops.length} text operation(s), candidate has ${after.ops.length}`
		});
	} else {
		const n = Math.min(before.ops.length, after.ops.length);
		for (let i = 0; i < n; i++) {
			const a = before.ops[i];
			const b = after.ops[i];
			if (a.op !== b.op) {
				problems.push({
					kind: 'op-kind',
					op: i,
					expected: a.op,
					actual: b.op,
					detail: `operation ${i}: expected ${a.op}, candidate has ${b.op}`
				});
				continue;
			}
			if (a.strings.length !== b.strings.length) {
				problems.push({
					kind: 'segment-count',
					op: i,
					operator: a.op,
					expected: a.strings.length,
					actual: b.strings.length,
					detail: `operation ${i} (${a.op}): expected ${a.strings.length} string segment(s), candidate has ${b.strings.length}`
				});
				continue;
			}
			for (let k = 0; k < a.strings.length; k++) {
				if (!equalBytes(a.strings[k], b.strings[k])) {
					problems.push({
						kind: 'segment-bytes',
						op: i,
						segment: k,
						operator: a.op,
						expectedBytes: a.strings[k].length,
						actualBytes: b.strings[k].length,
						expected: preview(a.strings[k]),
						actual: preview(b.strings[k]),
						detail:
							`operation ${i} (${a.op}) segment ${k}: expected ` +
							`[${preview(a.strings[k], 32)}] got [${preview(b.strings[k], 32)}]`
					});
				}
			}
		}
	}

	return { ok: problems.length === 0, problems };
}

function describeFirstByteDifference(a, b) {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		if (a[i] !== b[i]) {
			return `first difference at byte ${i}: expected 0x${a[i].toString(16)}, got 0x${b[i].toString(16)}`;
		}
	}
	return `common prefix of ${n} bytes, then original ends (expected ${a.length}B, got ${b.length}B)`;
}

/**
 * Compare two document signatures.
 *
 * Page count is checked first and independently: comparing text across a page
 * mismatch would pair pages that do not correspond.
 */
export function compareText(before, after) {
	const problems = [];

	if (!before.readable) {
		problems.push({ kind: 'unreadable-original', detail: 'the original document could not be parsed' });
	}
	if (before.pageCount !== after.pageCount) {
		problems.push({
			kind: 'page-count',
			expected: before.pageCount,
			actual: after.pageCount,
			detail: `original has ${before.pageCount} page(s), candidate has ${after.pageCount}`
		});
		return { ok: false, problems, pages: [] };
	}

	const pageResults = [];
	const n = Math.max(before.pages.length, after.pages.length);
	for (let i = 0; i < n; i++) {
		const a = before.pages[i];
		const b = after.pages[i];
		if (!a || !b) {
			problems.push({
				kind: 'page-missing',
				page: i + 1,
				detail: `page ${i + 1} is ${a ? 'present in the original but ' : ''}missing from the candidate`
			});
			continue;
		}
		const r = comparePage(a, b);
		pageResults.push({ page: i + 1, ok: r.ok, problems: r.problems, ops: a.ops.length, bytes: a.text.length });
		for (const p of r.problems) problems.push({ ...p, page: i + 1 });
	}

	return { ok: problems.length === 0, problems, pages: pageResults };
}

/** A one-line summary suitable for an assertion failure message. */
export function describeTextProblems(problems, limit = 4) {
	if (!problems.length) return 'no differences';
	const head = problems.slice(0, limit).map((p) => {
		const where = p.page ? `page ${p.page}` : 'document';
		return `${where}/${p.kind}: ${p.detail ?? `${p.expected} -> ${p.actual}`}`;
	});
	const more = problems.length > limit ? ` (+${problems.length - limit} more)` : '';
	return `${problems.length} difference(s): ${head.join('; ')}${more}`;
}