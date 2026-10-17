/**
 * Semantic comparison between an original PDF and a processed one.
 *
 * Structural validity is not preservation. A file can pass `qpdf --check`,
 * shrink by half, and still have lost every link, or silently reordered its
 * pages. This compares the things a reader would actually notice.
 *
 * Two deliberate rules:
 *
 *   1. Object numbers are never compared. QPDF renumbers freely, and the
 *      layout of an object stream is an implementation detail. A changed
 *      object number is not a defect; a missing page or a lost link is.
 *
 *   2. An unreadable field is reported as "unknown", never as a difference.
 *      The structure reader is best-effort, so treating "I could not read this"
 *      as "this changed" would manufacture false failures. Genuine loss still
 *      shows up, because a *readable* field on one side and `null` on the
 *      other is a real, reportable asymmetry.
 */
import { readStructure } from '../../src/lib/qpdf/structure.ts';

const fmt = (v) => (v === null || v === undefined ? 'unknown' : JSON.stringify(v));

/**
 * Compare two *flattened* documents.
 *
 * Both sides must already have been run through `--object-streams=disable`;
 * see readStructure's contract.
 *
 * @returns {{diffs: Array<{field: string, before: string, after: string}>, before: any, after: any}}
 */
export function compareStructure(beforeText, afterText) {
	const a = readStructure(beforeText);
	const b = readStructure(afterText);
	const diffs = [];

	const push = (field, x, y) => {
		if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push({ field, before: fmt(x), after: fmt(y) });
	};

	/* Whole-document facts */
	push('readable', a.readable, b.readable);
	push('pageCount', a.pageCount, b.pageCount);
	push('declaredPageCount', a.declaredCount, b.declaredCount);
	push('objectCount', a.objectCount, b.objectCount);
	push('hasOutlines', a.hasOutlines, b.hasOutlines);
	push('hasAcroForm', a.hasAcroForm, b.hasAcroForm);
	push('formFields', a.formFields, b.formFields);
	push('outlineTitles', a.outlineTitles, b.outlineTitles);
	push('hasMetadata', a.hasMetadata, b.hasMetadata);
	push('hasInfo', a.hasInfo, b.hasInfo);
	push('hasEncrypt', a.hasEncrypt, b.hasEncrypt);
	push('hasNames', a.hasNames, b.hasNames);

	/* Per page, in display order */
	const n = Math.max(a.pages.length, b.pages.length);
	for (let i = 0; i < n; i++) {
		const pa = a.pages[i];
		const pb = b.pages[i];
		const at = `page[${i + 1}]`;
		if (!pa || !pb) {
			diffs.push({ field: at, before: pa ? 'present' : 'missing', after: pb ? 'present' : 'missing' });
			continue;
		}
		push(`${at}.mediaBox`, pa.mediaBox, pb.mediaBox);
		push(`${at}.cropBox`, pa.cropBox, pb.cropBox);
		push(`${at}.rotate`, pa.rotate, pb.rotate);
		push(`${at}.annotCount`, pa.annotCount, pb.annotCount);
		push(`${at}.annotSubtypes`, pa.annotSubtypes, pb.annotSubtypes);
		push(`${at}.linkUris`, pa.linkUris, pb.linkUris);
		push(`${at}.hasContents`, pa.hasContents, pb.hasContents);
		push(`${at}.unreadable`, pa.unreadable, pb.unreadable);
	}

	/* Images.
	 *
	 * The COUNT is deliberately not compared: deduplication legitimately
	 * removes byte-identical copies, so three identical scans become one image
	 * object while the document still draws exactly the same pixels on all
	 * three pages. Counting would report correct behaviour as drift.
	 *
	 * What must hold is that the set of DISTINCT images is unchanged. That every
	 * surviving payload was already present in the input, byte-for-byte, is
	 * asserted separately by the integrity suite.
	 */
	push(
		'distinctImages',
		[...new Set([...a.images.values()].map(imageKey))].sort(),
		[...new Set([...b.images.values()].map(imageKey))].sort()
	);

	return { diffs, before: a, after: b };
}

/** A comparable identity for an image: everything that determines rendering. */
const imageKey = (i) =>
	`${i.width}x${i.height} ${i.colorspace} bpc=${i.bitsPerComponent} ${i.filters} smask=${i.hasSMask}`;

/** A one-line summary suitable for an assertion failure message. */
export function describeDiffs(diffs, limit = 6) {
	if (!diffs.length) return 'no differences';
	const head = diffs.slice(0, limit).map((d) => `${d.field}: ${d.before} -> ${d.after}`);
	const more = diffs.length > limit ? ` (+${diffs.length - limit} more)` : '';
	return `${diffs.length} difference(s): ${head.join('; ')}${more}`;
}

export { readStructure };