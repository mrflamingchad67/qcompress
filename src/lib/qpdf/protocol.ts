/**
 * Worker protocol between the page and the QPDF WASM engine.
 *
 * Kept as plain structured-clone messages: no Comlink, no runtime dependency.
 */

import type { QualityMode } from './pipeline';

export interface InspectResult {
	/** qpdf could open the document without a password. */
	readable: boolean;
	/** Document is encrypted (per qpdf's own encryption report). */
	encrypted: boolean;
	/** A non-empty user password is required to open it. */
	needsPassword: boolean;
	pageCount: number | null;
	pdfVersion: string | null;
	/** First meaningful qpdf diagnostic, when capture is available. */
	detail: string | null;
}

export interface ProcessResult {
	ok: boolean;
	/** qpdf process exit status (0 ok, 2 error, 3 warnings-only). */
	exitCode: number;
	bytes: ArrayBuffer | null;
	size: number;
	detail: string | null;
	/** True when qpdf told us the problem was the password. */
	invalidPassword: boolean;
	/** Which strategy won: structural, linearize, dedupe, image-aware... */
	strategy: string;
	/** True when images were re-encoded, i.e. the result is lossy. */
	lossy: boolean;
	/** True when nothing beat the original and the input was returned as-is. */
	fallback: boolean;
	/** Images examined and how many were actually rewritten. */
	imagesProcessed: number;
	imagesReplaced: number;
	/**
	 * Why images were left alone, counted by reason.
	 *
	 * Without this a document full of unsupported images just reports
	 * "unchanged", which reads as the compressor giving up rather than as a
	 * deliberate, safe decision.
	 */
	imageSkips: { reason: string; count: number }[];
	/** Wall-clock time for the whole run. */
	durationMs: number;
}

export type WorkerRequest =
	| { id: number; kind: 'inspect'; buffer: ArrayBuffer }
	| { id: number; kind: 'process'; buffer: ArrayBuffer; mode: QualityMode; password: string };

export type WorkerResponse =
	| { id: number; kind: 'ready' }
	| { id: number; kind: 'inspect'; result: InspectResult }
	| { id: number; kind: 'process'; result: ProcessResult }
	| { id: number; kind: 'status'; stage: string }
	| { id: number; kind: 'error'; message: string };