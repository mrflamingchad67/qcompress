/**
 * Main-thread client for the QPDF worker.
 *
 * Responsibilities:
 *  - own the single worker instance (spawned lazily, so the WASM is only
 *    downloaded when the visitor actually selects a file)
 *  - keep a private copy of the original bytes so a failed run can be retried,
 *    or the original downloaded, without asking the user to pick the file again
 *  - release object URLs when they are replaced
 */

import type { QualityMode } from './pipeline';
import type { InspectResult, ProcessResult, WorkerRequest, WorkerResponse } from './protocol';

export type ProgressStage = 'idle' | 'loading' | 'inspecting' | 'compressing';

export class QpdfEngine {
	#worker: Worker | null = null;
	#nextId = 1;
	#original: Uint8Array | null = null;
	#resultUrl: string | null = null;

	/** Lazily spawn the worker; the WASM bundle loads with it. */
	async #ensureWorker(): Promise<Worker> {
		if (this.#worker) return this.#worker;
		const { default: QpdfWorker } = await import('./worker?worker');
		const worker = new QpdfWorker();
		this.#worker = worker;
		return worker;
	}

	async #call<T>(
		build: (id: number) => WorkerRequest,
		pick: (res: WorkerResponse) => T,
		onStatus?: (stage: ProgressStage) => void
	): Promise<T> {
		const id = this.#nextId++;
		const worker = await this.#ensureWorker();

		return new Promise<T>((resolve, reject) => {
			const handler = (event: MessageEvent<WorkerResponse>) => {
				const data = event.data;

				// Unsolicited stage updates (id === -1).
				if (data.id === -1 && data.kind === 'status') {
					onStatus?.(data.stage === 'Compressing' ? 'compressing' : 'loading');
					return;
				}
				if (data.id !== id) return;

				worker.removeEventListener('message', handler);
				if (data.kind === 'error') {
					reject(new Error(data.message));
					return;
				}
				try {
					resolve(pick(data));
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			};

			worker.addEventListener('message', handler);

			const message = build(id);
			// Transfer the copy: no structured-clone copy of the PDF is made.
			worker.postMessage(message, [message.buffer]);
		});
	}

	/** Read the file, retain our own copy, and ask qpdf to describe it. */
	async inspect(file: File, onStatus?: (s: ProgressStage) => void): Promise<InspectResult> {
		const bytes = new Uint8Array(await file.arrayBuffer());
		this.#original = bytes;
		this.#releaseResult();

		const copy = bytes.slice();
		onStatus?.('inspecting');
		try {
			return await this.#call<InspectResult>(
				(id) => ({ id, kind: 'inspect', buffer: copy.buffer }),
				(res) => {
					if (res.kind !== 'inspect') throw new Error('Unexpected worker response');
					return res.result;
				},
				onStatus
			);
		} finally {
			onStatus?.('idle');
		}
	}

	/** Run the orchestrator. The worker's bytes are a copy; our original is never touched. */
	async process(
		mode: QualityMode,
		password: string,
		onStatus?: (s: ProgressStage) => void
	): Promise<ProcessResult> {
		if (!this.#original) throw new Error('No file loaded');

		const copy = this.#original.slice();
		onStatus?.('compressing');
		try {
			return await this.#call<ProcessResult>(
				(id) => ({ id, kind: 'process', buffer: copy.buffer, mode, password }),
				(res) => {
					if (res.kind !== 'process') throw new Error('Unexpected worker response');
					return res.result;
				},
				onStatus
			);
		} finally {
			onStatus?.('idle');
		}
	}

	get originalSize(): number | null {
		return this.#original ? this.#original.length : null;
	}

	/** Untouched original bytes, offered when processing fails. */
	getOriginal(): Blob | null {
		return this.#original
			? new Blob([this.#original.slice().buffer], { type: 'application/pdf' })
			: null;
	}

	#releaseResult() {
		if (this.#resultUrl) {
			URL.revokeObjectURL(this.#resultUrl);
			this.#resultUrl = null;
		}
	}

	/** Take ownership of a result URL; any previous one is revoked. */
	adoptResultUrl(url: string) {
		this.#releaseResult();
		this.#resultUrl = url;
	}

	reset() {
		this.#releaseResult();
		this.#original = null;
	}

	destroy() {
		this.reset();
		this.#worker?.terminate();
		this.#worker = null;
	}
}

/** Single engine instance for the page. */
export const engine = new QpdfEngine();