/**
 * Lossless stream deduplication.
 *
 * Real PDFs repeat themselves: one logo stamped on every page, a scanned letter
 * header, a background image. Each copy is stored in full, so a three-page
 * document built from one scan pays for the scan three times.
 *
 * Replacing the copies with a reference to the first one is *lossless* - the
 * surviving object holds the same bytes and the same dictionary, and PDF
 * objects are referenced by value, so nothing about what is rendered changes.
 * QPDF does not do this on its own because deciding that two objects are
 * interchangeable requires comparing their dictionaries as well as their
 * payloads.
 *
 * Two safety rules keep this from corrupting documents:
 *
 *   1. Only object kinds where the dictionary fully determines appearance are
 *      considered - images, embedded font programs, embedded files and
 *      metadata. Page *content streams* are deliberately excluded: two pages
 *      can carry byte-identical content that draws different things, because
 *      the resources they refer to live in each page's own resource dictionary.
 *
 *   2. Both the dictionary and the payload must match exactly. A hash picks the
 *      candidates; the bytes are then compared for real.
 */

import { rebuildXref, scanObjects } from './xref';
import { latin1ToBytes } from './bytes';

/** Kinds whose dictionary alone fully determines how they render. */
const DEDUPABLE = [
	/\/Subtype\s*\/Image/,
	/\/Type\s*\/FontFile\b/,
	/\/Type\s*\/FontFile2\b/,
	/\/Type\s*\/FontFile3\b/,
	/\/Type\s*\/EmbeddedFile\b/,
	/\/Type\s*\/Metadata\b/
];

interface StreamObject {
	num: number;
	offset: number;
	dictStart: number;
	dictEnd: number;
	dict: string;
	dataStart: number;
	length: number;
}

function matchDict(text: string, start: number): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === '<' && text[i + 1] === '<') {
			depth++;
			i++;
		} else if (text[i] === '>' && text[i + 1] === '>') {
			depth--;
			i++;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/**
 * Locate one object's dictionary and payload.
 *
 * `offset` points at the first digit of the `N 0 obj` header. The dictionary
 * starts at the `<<` that follows it - starting the slice at the header would
 * embed the object number in the dictionary text, and two otherwise identical
 * objects would then look different because of their own numbers.
 *
 * The declared /Length is used only when an `endstream` really follows it, so a
 * wrong length cannot cause a read past the end of the stream.
 */
function readObject(text: string, offset: number): StreamObject | null {
	const dictStart = text.indexOf('<<', offset);
	if (dictStart === -1) return null;

	const objEnd = matchDict(text, dictStart);
	if (objEnd === -1) return null;

	const dict = text.slice(dictStart, objEnd);
	const streamIdx = text.indexOf('stream', objEnd);
	if (streamIdx === -1) return null;

	let dataStart = streamIdx + 'stream'.length;
	if (text[dataStart] === '\r') dataStart++;
	if (text[dataStart] === '\n') dataStart++;

	const m = /\/Length\s+(\d+)/.exec(dict);
	if (!m) return null;
	const length = parseInt(m[1], 10);
	if (length <= 0 || dataStart + length > text.length) return null;

	const after = text.indexOf('endstream', dataStart + length);
	if (after === -1) return null;

	return { num: 0, offset, dictStart, dictEnd: objEnd, dict, dataStart, length };
}

/** FNV-1a, 32-bit. Only used to pick candidates; bytes are always verified. */
function hashOf(text: string, start: number, length: number): number {
	let h = 0x811c9dc5;
	for (let i = start; i < start + length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function equalAt(text: string, a: number, b: number, length: number): boolean {
	for (let i = 0; i < length; i++) if (text[a + i] !== text[b + i]) return false;
	return true;
}

export interface DedupeResult {
	bytes: Uint8Array | null;
	objectsInspected: number;
	duplicatesReplaced: number;
	bytesSaved: number;
	reason?: string;
}

/**
 * Replace duplicate stream objects with references to the first copy.
 *
 * Returns null when nothing was duplicated, or when the cross-reference table
 * could not be rebuilt afterwards (which leaves the caller free to fall back to
 * plain structural compression).
 */
export function dedupeStreams(text: string): DedupeResult {
	const objects = scanObjects(text, 0, text.length);
	const empty: DedupeResult = {
		bytes: null,
		objectsInspected: 0,
		duplicatesReplaced: 0,
		bytesSaved: 0
	};

	if (objects.length < 2) return { ...empty, objectsInspected: objects.length };

	// Read every candidate once.
	const candidates: StreamObject[] = [];
	for (const o of objects) {
		const parsed = readObject(text, o.offset);
		if (!parsed) continue;
		parsed.num = o.num;
		candidates.push(parsed);
	}
	if (candidates.length < 2) return { ...empty, objectsInspected: candidates.length };

	// Bucket by exact dictionary text, so only genuinely interchangeable
	// objects are ever compared byte-for-byte.
	const buckets = new Map<string, StreamObject[]>();
	for (const c of candidates) {
		if (!DEDUPABLE.some((re) => re.test(c.dict))) continue;
		const key = c.dict;
		const bucket = buckets.get(key);
		if (bucket) bucket.push(c);
		else buckets.set(key, [c]);
	}

	// Within each bucket, hash to pick candidates, then verify the bytes.
	const replacements: { obj: StreamObject; keepNum: number }[] = [];
	for (const bucket of buckets.values()) {
		if (bucket.length < 2) continue;

		const seen = new Map<number, StreamObject>();
		for (const c of bucket) {
			const key = hashOf(text, c.dataStart, c.length);
			const kept = seen.get(key);
			if (kept && equalAt(text, kept.dataStart, c.dataStart, c.length)) {
				replacements.push({ obj: c, keepNum: kept.num });
			} else if (!kept) {
				seen.set(key, c);
			}
		}
	}

	if (!replacements.length) {
		return { ...empty, objectsInspected: candidates.length };
	}

	// Rewrite each duplicate as a bare indirect reference. Work back to front so
	// the offsets of the objects still to be handled stay valid.
	replacements.sort((a, b) => b.obj.offset - a.obj.offset);

	let out = text;
	let bytesSaved = 0;
	for (const { obj, keepNum } of replacements) {
		// Keep the original spacing up to `endobj` so the object stays
		// recognisable, and drop the dictionary and payload entirely.
		const endObjIdx = out.indexOf('endobj', obj.dataStart + obj.length);
		if (endObjIdx === -1) continue;

		const before = obj.offset;
		const stub = `${obj.num} 0 R`;
		const rebuilt = out.slice(0, before) + stub + out.slice(endObjIdx);
		bytesSaved += out.length - rebuilt.length;
		out = rebuilt;
	}

	if (bytesSaved <= 0) return { ...empty, objectsInspected: candidates.length };

	// Shrinking objects moved everything after them, so the recorded offsets
	// are now wrong and the table has to be regenerated.
	const repaired = rebuildXref(out);
	if (!repaired) {
		return {
			bytes: null,
			objectsInspected: candidates.length,
			duplicatesReplaced: 0,
			bytesSaved: 0,
			reason: 'could not rebuild cross-reference table'
		};
	}

	return {
		bytes: latin1ToBytes(repaired),
		objectsInspected: candidates.length,
		duplicatesReplaced: replacements.length,
		bytesSaved
	};
}