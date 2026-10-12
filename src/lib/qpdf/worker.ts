/**
 * QPDF WASM worker.
 *
 * Every PDF byte stays inside this worker. Nothing is uploaded, logged or sent
 * anywhere: the page receives back only the processed bytes and size numbers.
 *
 * Engine notes (verified by running the build and by scripts/test-browser.mjs):
 *  - qpdf 12.4.2
 *  - This build does NOT honour Module.print / Module.printErr: diagnostics
 *    are written straight to the console. Both in a browser worker and under
 *    Node/Bun (where it additionally links nodefs). So `callMain` is wrapped in
 *    a console sink; the print handlers are kept as a secondary net.
 *  - `--json` cannot be reused on a long-lived instance ("called setSave on
 *    standard output after standard output has already been used"), so each
 *    operation gets its own module instance. Instantiation is ~15ms.
 *  - `callMain` is fully synchronous, so swapping console sinks around it is
 *    safe: no other work can interleave inside this worker.
 */

import wasmUrl from '#lib/vendors/qpdf.wasm?url';
import { buildArgs } from './options';
import type { InspectResult, ProcessResult, WorkerRequest, WorkerResponse } from './protocol';

/** qpdf exit statuses (see `--help=exit-status`). */
const EXIT_OK = 0;
const EXIT_ERROR = 2;

type QpdfModule = {
	FS: {
		writeFile(path: string, data: Uint8Array): void;
		readFile(path: string): Uint8Array;
		unlink(path: string): void;
		stat(path: string): { size: number };
	};
	callMain(args: string[]): number;
};

function post(message: WorkerResponse, transfer: Transferable[] = []) {
	(self as unknown as Worker).postMessage(message, transfer);
}

/** Temp names never include user data - only random ids. */
let counter = 0;
const tmpName = (prefix: string, ext: string) => `${prefix}_${Date.now().toString(36)}_${counter++}${ext}`;

/** Lines captured from one qpdf run. */
interface Output {
	stdout: string[];
	stderr: string[];
}

/*
 * Console capture.
 *
 * This Emscripten build ignores Module.print/Module.printErr and binds
 * `console.log` / `console.error` once, when the glue module is first
 * evaluated. Two consequences:
 *
 *  1. Swapping the console around `callMain` is too late — the glue already
 *     holds the original functions. The wrappers below must be installed
 *     *before* the glue is ever loaded.
 *  2. A static `import` would be hoisted and evaluated before this module body
 *     runs, so the glue is loaded with a dynamic `import()` instead.
 *
 * The wrappers pass everything through to the real console unless a capture is
 * active, so genuine errors still reach devtools.
 */
let sinkOut: string[] | null = null;
let sinkErr: string[] | null = null;

(function installConsoleCapture() {
	const origLog = console.log.bind(console);
	const origErr = console.error.bind(console);
	const origWarn = console.warn.bind(console);
	const fmt = (parts: unknown[]) => parts.map((p) => String(p)).join(' ') + '\n';

	console.log = (...parts: unknown[]) => {
		if (sinkOut) sinkOut.push(fmt(parts));
		else origLog(...parts);
	};
	console.error = (...parts: unknown[]) => {
		if (sinkErr) sinkErr.push(fmt(parts));
		else origErr(...parts);
	};
	console.warn = (...parts: unknown[]) => {
		if (sinkErr) sinkErr.push(fmt(parts));
		else origWarn(...parts);
	};
})();

/**
 * Run `callMain` with output diverted into `output`.
 *
 * `callMain` is synchronous and this worker runs no other code while it is on
 * the stack, so swapping the active sink cannot lose or mix output.
 */
function runCaptured(mod: QpdfModule, args: string[], output: Output): number {
	const prevOut = sinkOut;
	const prevErr = sinkErr;
	sinkOut = output.stdout;
	sinkErr = output.stderr;
	try {
		return mod.callMain(args);
	} finally {
		sinkOut = prevOut;
		sinkErr = prevErr;
	}
}

/**
 * The WASM binary, fetched once per worker.
 *
 * Each operation builds a fresh qpdf instance (see loadQpdf), but this build's
 * Emscripten runtime always re-requests the 1.5 MB binary — it does not honour
 * `Module.wasmBinary`. Intercepting just that one request and serving the
 * cached bytes keeps the worker on the network exactly once.
 */
let wasmBinary: ArrayBuffer | null = null;

/**
 * The Emscripten factory, loaded lazily.
 *
 * Imported dynamically on purpose: a static import would be hoisted and
 * evaluated before the console capture above is installed, and the glue binds
 * `console.log` at evaluation time — too early for us to ever see its output.
 */
let factory: typeof import('#lib/vendors/qpdf.js').default | null = null;

async function getFactory(): Promise<typeof import('#lib/vendors/qpdf.js').default> {
	if (!factory) {
		factory = (await import('#lib/vendors/qpdf.js')).default;
	}
	return factory;
}

async function getWasmBinary(): Promise<ArrayBuffer> {
	if (!wasmBinary) {
		const res = await fetch(wasmUrl);
		if (!res.ok) {
			throw new Error(`Could not load the QPDF engine (HTTP ${res.status}).`);
		}
		wasmBinary = await res.arrayBuffer();
	}
	return wasmBinary;
}

let wasmCacheInstalled = false;

/**
 * Make `fetch(<our wasm url>)` resolve from the in-memory cache.
 *
 * Scoped to this module's own binary; every other request passes through.
 * Emscripten uses `instantiateStreaming`, so the synthetic Response must carry
 * the `application/wasm` content type.
 */
function installWasmCache(): void {
	if (wasmCacheInstalled) return;
	wasmCacheInstalled = true;

	const passthrough = self.fetch.bind(self);

	self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: (input as Request).url;

		if (url.endsWith('.wasm') && wasmBinary) {
			return new Response(wasmBinary, {
				headers: { 'content-type': 'application/wasm' }
			});
		}
		return passthrough(input, init);
	};
}

/**
 * Load a fresh QPDF instance with diagnostics captured.
 *
 * A fresh instance per call keeps qpdf's global logger happy and guarantees
 * that whatever qpdf emits is attributable to the command we ran.
 *
 * stdout and stderr are kept apart: `--json` writes structured output to
 * stdout, and a warning on stderr must not corrupt the parse.
 */
async function loadQpdf(): Promise<{ mod: QpdfModule; output: Output }> {
	const output: Output = { stdout: [], stderr: [] };

	// First call populates the cache; later calls are served from it.
	await getWasmBinary();
	installWasmCache();

	const createModule = await getFactory();
	const mod = (await createModule({
		noInitialRun: true,
		print: (line: string) => output.stdout.push(line),
		printErr: (line: string) => output.stderr.push(line),
		locateFile: (file: string) => (file.endsWith('.wasm') ? wasmUrl : file)
	})) as unknown as QpdfModule;

	return { mod, output };
}

/**
 * Run `callMain` with the console sinks temporarily redirected.
 *
 * @deprecated superseded by the module-level capture in installConsoleCapture().
 */
function runCapturedLegacy(mod: QpdfModule, args: string[], output: Output): number {
	const consoleOut: string[] = [];
	const consoleErr: string[] = [];
	const join = (parts: unknown[]) => parts.map((p) => String(p)).join(' ') + '\n';

	const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
	console.log = (...a: unknown[]) => void consoleOut.push(join(a));
	console.error = (...a: unknown[]) => void consoleErr.push(join(a));
	console.warn = (...a: unknown[]) => void consoleErr.push(join(a));
	console.info = (...a: unknown[]) => void consoleOut.push(join(a));

	try {
		return mod.callMain(args);
	} finally {
		Object.assign(console, orig);
		output.stdout.push(...consoleOut);
		output.stderr.push(...consoleErr);
	}
}

function cleanup(mod: QpdfModule, ...paths: string[]) {
	for (const p of paths) {
		try {
			mod.FS.unlink(p);
		} catch {
			/* already gone */
		}
	}
}

/** Copy out of the WASM heap so we never transfer or alias Emscripten memory. */
function detach(view: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(new ArrayBuffer(view.length));
	copy.set(view);
	return copy;
}

/**
 * Last-resort encryption hint that does not depend on capturing qpdf output.
 *
 * Looks for an /Encrypt indirect reference, which is how the trailer declares
 * encryption. Deliberately conservative: any doubt means "offer a password",
 * never "silently drop the document".
 */
function looksEncrypted(bytes: Uint8Array): boolean {
	const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4_000_000)));
	return /\/Encrypt\s+\d+\s+\d+\s+R/.test(text);
}

function firstMeaningfulLine(lines: string[]): string | null {
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Drop the "qpdf: --help" usage spam and bare program-name echoes.
		if (/^For help:/i.test(trimmed)) continue;
		if (/^\S*\s*(--version|--copyright)/i.test(trimmed)) continue;
		// Skip the --json payload: it is data, not a diagnostic.
		if (/^[[{"]/.test(trimmed)) continue;
		if (/^[}\]]/.test(trimmed)) continue;
		return trimmed;
	}
	return null;
}

/**
 * qpdf's own words.
 *
 * This build routes every diagnostic through the console sink, which lands in
 * `stdout`, so both streams are searched. stderr is preferred when it has
 * something, since a genuine error message is more likely to arrive there.
 */
function diagnose(output: Output): { detail: string | null; invalidPassword: boolean } {
	const all = [...output.stderr, ...output.stdout].join('\n');
	const invalidPassword = /invalid password/i.test(all);
	const detail = firstMeaningfulLine(output.stderr) ?? firstMeaningfulLine(output.stdout);
	return { detail, invalidPassword };
}

async function inspect(buffer: ArrayBuffer): Promise<InspectResult> {
	const input = new Uint8Array(buffer);
	const scanned = looksEncrypted(input);
	const { mod, output } = await loadQpdf();
	const inFile = tmpName('in', '.pdf');
	const unreadable: InspectResult = {
		readable: false,
		encrypted: scanned,
		needsPassword: scanned,
		pageCount: null,
		pdfVersion: null,
		detail: firstMeaningfulLine(output.stderr)
	};

	try {
		mod.FS.writeFile(inFile, input);
		const exitCode = runCaptured(
			mod,
			['--json=latest', '--json-key=encrypt', '--json-key=pages', inFile],
			output
		);

		if (exitCode !== EXIT_OK) {
			const { detail, invalidPassword } = diagnose(output);
			unreadable.detail = detail;
			unreadable.encrypted = invalidPassword || scanned;
			unreadable.needsPassword = invalidPassword || scanned;
			return unreadable;
		}

		// qpdf writes --json to stdout.
		const jsonStart = output.stdout.findIndex((l) => l.trim().startsWith('{'));
		let json: Record<string, any> | null = null;
		if (jsonStart !== -1) {
			try {
				json = JSON.parse(output.stdout.slice(jsonStart).join('\n'));
			} catch {
				json = null;
			}
		}

		const enc = json?.encrypt;
		const encrypted = typeof enc?.encrypted === 'boolean' ? enc.encrypted : scanned;
		const userPwMatched = enc?.userpasswordmatched;

		return {
			readable: true,
			encrypted,
			// An encrypted file whose user password we did not match needs one.
			needsPassword: encrypted && userPwMatched !== true,
			pageCount: Array.isArray(json?.pages) ? json.pages.length : null,
			pdfVersion: typeof json?.qpdf?.pdf === 'string' ? json.qpdf.pdf : null,
			detail: firstMeaningfulLine(output.stderr)
		};
	} catch (err) {
		unreadable.detail = err instanceof Error ? err.message : String(err);
		return unreadable;
	} finally {
		cleanup(mod, inFile);
	}
}

async function process(
	buffer: ArrayBuffer,
	options: Parameters<typeof buildArgs>[0],
	password: string
): Promise<ProcessResult> {
	const input = new Uint8Array(buffer);
	const { mod, output } = await loadQpdf();
	const inFile = tmpName('in', '.pdf');
	const outFile = tmpName('out', '.pdf');
	let passFile: string | null = null;

	try {
		mod.FS.writeFile(inFile, input);

		const args = buildArgs(options);

		if (password) {
			passFile = tmpName('pw', '.txt');
			// Password is written to the in-memory FS only, never to disk.
			mod.FS.writeFile(passFile, new TextEncoder().encode(password));
			args.push('--password-file=' + passFile);
			if (options.mode === 'compress') args.push('--decrypt');
		}

		args.push(inFile, outFile);

		post({ id: -1, kind: 'status', stage: 'Compressing' });
		const exitCode = runCaptured(mod, args, output);

		if (exitCode === EXIT_ERROR) {
			const { detail, invalidPassword } = diagnose(output);
			return {
				ok: false,
				exitCode,
				bytes: null,
				size: 0,
				detail,
				invalidPassword
			};
		}

		let result: Uint8Array<ArrayBuffer>;
		try {
			result = detach(mod.FS.readFile(outFile));
		} catch {
			return {
				ok: false,
				exitCode,
				bytes: null,
				size: 0,
				detail: diagnose(output).detail ?? 'QPDF produced no output file.',
				invalidPassword: false
			};
		}

		// Sanity check: refuse to hand back something that is not a PDF.
		const header = new TextDecoder('latin1').decode(result.subarray(0, 5));
		if (header !== '%PDF-') {
			return {
				ok: false,
				exitCode,
				bytes: null,
				size: 0,
				detail: 'Output was not a valid PDF.',
				invalidPassword: false
			};
		}

		return {
			ok: true,
			exitCode,
			bytes: result.buffer,
			size: result.length,
			detail: null,
			invalidPassword: false
		};
	} catch (err) {
		return {
			ok: false,
			exitCode: EXIT_ERROR,
			bytes: null,
			size: 0,
			detail: err instanceof Error ? err.message : String(err),
			invalidPassword: false
		};
	} finally {
		cleanup(mod, inFile, outFile, ...(passFile ? [passFile] : []));
	}
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
	const msg = event.data;

	try {
		if (msg.kind === 'inspect') {
			const result = await inspect(msg.buffer);
			post({ id: msg.id, kind: 'inspect', result });
			return;
		}

		if (msg.kind === 'process') {
			const result = await process(msg.buffer, msg.options, msg.password);
			post(
				{ id: msg.id, kind: 'process', result },
				result.bytes ? [result.bytes] : []
			);
			return;
		}
	} catch (err) {
		post({
			id: msg.id,
			kind: 'error',
			message: err instanceof Error ? err.message : String(err)
		});
	}
};