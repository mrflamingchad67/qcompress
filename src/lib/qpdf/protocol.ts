/**
 * Worker protocol between the page and the QPDF WASM engine.
 *
 * Kept as plain structured-clone messages: no Comlink, no runtime dependency.
 */

import type { CompressOptions } from './options';

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
}

export type WorkerRequest =
	| { id: number; kind: 'inspect'; buffer: ArrayBuffer }
	| { id: number; kind: 'process'; buffer: ArrayBuffer; options: CompressOptions; password: string };

export type WorkerResponse =
	| { id: number; kind: 'ready' }
	| { id: number; kind: 'inspect'; result: InspectResult }
	| { id: number; kind: 'process'; result: ProcessResult }
	| { id: number; kind: 'status'; stage: string }
	| { id: number; kind: 'error'; message: string };