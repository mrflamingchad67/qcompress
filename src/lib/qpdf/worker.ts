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
import { optimize, type ImageCodec, type QualityMode } from './pipeline';
import type { ZipCodec } from './pipeline';
import { detach as detachBytes } from './bytes';
import type { InspectResult, ProcessResult, WorkerRequest, WorkerResponse } from './protocol';

/** qpdf exit statuses (see `--help=exit-status`). */
const EXIT_OK = 0;
const EXIT_WARN = 3;
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
 * Scoped by **exact URL**, not by extension. This worker also lazily loads the
 * jSquash JPEG codec, which fetches its *own* `.wasm` files (mozjpeg_enc,
 * squoosh_resize, …). Matching on `.wasm` would hand every one of them the QPDF
 * binary, the codec would fail to instantiate, and the lossy modes would
 * silently do nothing at all. Every other request passes through untouched.
 *
 * Emscripten uses `instantiateStreaming`, so the synthetic Response must carry
 * the `application/wasm` content type.
 */
function installWasmCache(): void {
	if (wasmCacheInstalled) return;
	wasmCacheInstalled = true;

	const passthrough = self.fetch.bind(self);

	// Absolute URL of the QPDF binary, so a relative request still matches.
	let qpdfWasmUrl: string;
	try {
		qpdfWasmUrl = new URL(wasmUrl, self.location.href).href;
	} catch {
		qpdfWasmUrl = wasmUrl;
	}

	self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: (input as Request).url;

		let absolute: string;
		try {
			absolute = new URL(url, self.location.href).href;
		} catch {
			absolute = url;
		}

		if (wasmBinary && absolute === qpdfWasmUrl) {
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

function cleanup(mod: QpdfModule, ...paths: (string | null | undefined)[]) {
	for (const p of paths) {
		if (!p) continue;
		try {
			mod.FS.unlink(p);
		} catch {
			/* already gone */
		}
	}
}

/** Copy out of the WASM heap so we never transfer or alias Emscripten memory. */
function detach(view: Uint8Array): Uint8Array<ArrayBuffer> {
	return detachBytes(view);
}

/**
 * The JPEG codec, loaded on demand.
 *
 * Lossless mode never touches an image, so it never downloads the codec - the
 * dependency is only fetched when the visitor picks a lossy mode *and* the
 * document actually contains JPEG images.
 *
 * `@jsquash/jpeg` uses named exports but `@jsquash/resize` exposes its function
 * as the default export; importing `resize` by name yields undefined and every
 * downscale throws.
 */
let codecPromise: Promise<ImageCodec> | null = null;

async function loadCodec(): Promise<ImageCodec> {
	if (codecPromise) return codecPromise;

	const build = async (): Promise<ImageCodec> => {
		const [{ decode, encode }, resizeModule] = await Promise.all([
			import('@jsquash/jpeg'),
			import('@jsquash/resize')
		]);
		const resize = resizeModule.default;

		// Hand the codecs a standalone ArrayBuffer: a view that aliases a
		// larger buffer makes them read past the end of the image.
		const toBuffer = (u8: Uint8Array): ArrayBuffer =>
			u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
				? (u8.buffer as ArrayBuffer)
				: (u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);

		return {
			decode: (jpeg: Uint8Array) => decode(toBuffer(jpeg)),
			// jSquash takes an options object, and returns an ArrayBuffer.
			encode: async (image: ImageData, quality: number) =>
				new Uint8Array(await encode(image, { quality })),
			resize: (image: ImageData, width: number, height: number) =>
				resize(image, { width, height })
		};
	};

	codecPromise = build();
	return codecPromise;
}

/**
 * Inflate/deflate for images stored Flate-wrapped around a JPEG.
 *
 * Real documents routinely use `/Filter [/FlateDecode /DCTDecode]`, which stores
 * a Flate-compressed JPEG. A worker has no Node `zlib`, but the platform has had
 * `CompressionStream` / `DecompressionStream` for years, so this costs no
 * dependency and no bundle weight. `'deflate'` is the zlib wrapper (RFC 1950),
 * which is exactly what a PDF's `/FlateDecode` uses.
 *
 * Absent in an old browser, the codec is null and those images are skipped
 * rather than corrupted.
 */
function makeZip(): ZipCodec {
	if (typeof DecompressionStream === 'undefined' || typeof CompressionStream === 'undefined') {
		return null;
	}
	return {
		async inflate(data) {
			const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
			return new Uint8Array(await new Response(stream).arrayBuffer());
		},
		async deflate(data) {
			const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
			return new Uint8Array(await new Response(stream).arrayBuffer());
		}
	};
}

/**
 * A QpdfRunner bound to this worker's WASM build and the caller's password.
 *
 * The pipeline builds argv but never credentials: the password is written to
 * the in-memory filesystem here and referenced by `--password-file`, so it is
 * never part of a command line, never logged, and never leaves the worker.
 */
function makeRunner(password: string) {
	return async (
		bytes: Uint8Array,
		args: string[]
	): Promise<{ code: number; out: Uint8Array | null; diagnostics: string }> => {
		const { mod, output } = await loadQpdf();
		const inFile = tmpName('in', '.pdf');
		const passFile = password ? tmpName('pw', '.txt') : null;
		// A check must never write anything, and qpdf wants no output file.
		const isCheck = args.includes('--check');
		const outFile = tmpName('out', '.pdf');

		try {
			mod.FS.writeFile(inFile, bytes);

			const argv = [...args];
			if (passFile) {
				mod.FS.writeFile(passFile, new TextEncoder().encode(password));
				argv.push(`--password-file=${passFile}`);
				if (!isCheck) argv.push('--decrypt');
			}
			argv.push(inFile);
			if (!isCheck) argv.push(outFile);

			post({ id: -1, kind: 'status', stage: 'Optimising structure' });
			const code = runCaptured(mod, argv, output);
			const diagnostics = [...output.stderr, ...output.stdout].join('\n');

			if (isCheck || (code !== EXIT_OK && code !== EXIT_WARN)) {
				return { code, out: null, diagnostics };
			}
			try {
				return { code, out: detach(mod.FS.readFile(outFile)), diagnostics };
			} catch {
				return { code, out: null, diagnostics };
			}
		} finally {
			cleanup(mod, inFile, isCheck ? null : outFile, passFile);
		}
	};
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

/**
 * Run the orchestrator.
 *
 * The pipeline generates several candidates, validates each one, and returns
 * the smallest that passes - or the original bytes untouched when nothing
 * beats them. A zero-gain result is a legitimate outcome and is reported as
 * such rather than dressed up as a success.
 */
async function process(
	buffer: ArrayBuffer,
	mode: QualityMode,
	password: string
): Promise<ProcessResult> {
	const input = new Uint8Array(buffer);
	const run = makeRunner(password);

	// A password is only meaningful if qpdf could not open the file on its own.
	// Probe first so an incorrect password is reported as such instead of
	// surfacing later as a confusing "no candidate improved this file".
	if (password) {
		const probe = await run(input, ['--check']);
		if (probe.code === EXIT_ERROR) {
			return {
				ok: false,
				exitCode: probe.code,
				bytes: null,
				size: 0,
				detail: /invalid password/i.test(probe.diagnostics)
					? 'Incorrect password.'
					: firstMeaningfulLine(probe.diagnostics.split('\n')) ?? 'QPDF could not open the file.',
				invalidPassword: /invalid password/i.test(probe.diagnostics),
				strategy: 'none',
				lossy: false,
				fallback: false,
				imagesProcessed: 0,
				imagesReplaced: 0,
				 imageSkips: [],
				durationMs: 0
			};
		}
	}

	try {
		// The codec is only needed for the lossy modes; a lossless run never
		// downloads it. If it fails to load the run still succeeds, but the
		// user is told why no image was re-encoded rather than being shown a
		// silent "nothing changed".
		let codec: ImageCodec | null = null;
		let codecError: string | null = null;
		if (mode !== 'lossless') {
			try {
				codec = await loadCodec();
			} catch (err) {
				codecError = err instanceof Error ? err.message : String(err);
				console.warn('[qcompress] JPEG codec unavailable:', codecError);
			}
		}

		const result = await optimize(
			{
				bytes: input,
				mode,
				zip: makeZip(),
				progress: (stage) => post({ id: -1, kind: 'status', stage })
			},
			run,
			codec
		);

		return {
			ok: true,
			exitCode: EXIT_OK,
			bytes: result.bytes.slice().buffer as ArrayBuffer,
			size: result.bytes.length,
			detail: null,
			invalidPassword: false,
			strategy: result.strategy,
			lossy: result.lossy,
			fallback: result.fallback,
			imagesProcessed: result.imagesProcessed,
			imagesReplaced: result.imagesReplaced,
			imageSkips: result.imageSkips,
			durationMs: result.durationMs
		};
	} catch (err) {
		return {
			ok: false,
			exitCode: EXIT_ERROR,
			bytes: null,
			size: 0,
			detail: err instanceof Error ? err.message : String(err),
			invalidPassword: false,
			strategy: 'none',
			lossy: false,
			fallback: false,
			imagesProcessed: 0,
			imagesReplaced: 0,
			 imageSkips: [],
			durationMs: 0
		};
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
			const result = await process(msg.buffer, msg.mode, msg.password);
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
