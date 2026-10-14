/**
 * Node/Bun harness for the compression engine.
 *
 * The app runs QPDF and the JPEG codec inside a Web Worker. Tests need the same
 * two things outside the browser, so this module supplies them:
 *
 *   makeRunner() - a QpdfRunner bound to the vendored WASM build
 *   makeCodec()  - an ImageCodec backed by jSquash
 *
 * Both are loaded lazily: nothing here runs until a test asks for it.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

/*
 * Console sink.
 *
 * This Emscripten build ignores Module.print and binds console.log when the
 * glue module is first evaluated, so the sink has to exist before the glue is
 * imported. Hence the dynamic import below rather than a static one.
 */
let capture = null;
for (const m of ['log', 'error', 'warn', 'info']) {
	console[m] = (...parts) => {
		if (capture) capture.push(parts.map(String).join(' '));
	};
}

const glue = await import(pathToFileURL(path.join(root, 'src', 'lib', 'vendors', 'qpdf.js')).href);

const newModule = () =>
	glue.default({
		noInitialRun: true,
		locateFile: (f) => path.join(root, 'src', 'lib', 'vendors', f)
	});

let uid = 0;
const tmp = (p, x) => `${p}_${Date.now().toString(36)}_${uid++}${x}`;

/** qpdf exit statuses: 0 ok, 2 error, 3 warnings only. */
const EXIT_OK = 0;
const EXIT_WARN = 3;

function cleanup(mod, ...paths) {
	for (const p of paths.filter(Boolean)) {
		try {
			mod.FS.unlink(p);
		} catch {
			/* already gone */
		}
	}
}

/**
 * Build a QpdfRunner.
 *
 * The runner owns the password, exactly as the worker does: it writes the
 * secret to the in-memory filesystem only and adds `--password-file` plus
 * `--decrypt`, so callers never assemble argv containing credentials.
 *
 * `['--check']` is treated specially - qpdf needs an input file but no output
 * file, and a check must never rewrite anything.
 */
export function makeRunner({ password = '', decrypt = true } = {}) {
	return async function run(bytes, args) {
		const mod = await newModule();
		const inFile = tmp('in', '.pdf');
		const outFile = tmp('out', '.pdf');
		const passFile = password ? tmp('pw', '.txt') : null;
		const isCheck = args.includes('--check');
		let diagnostics = '';

		try {
			mod.FS.writeFile(inFile, bytes);

			const argv = [...args];
			if (passFile) {
				// Secrets live only in the in-memory filesystem.
				mod.FS.writeFile(passFile, new Uint8Array(Buffer.from(password, 'utf8')));
				argv.push(`--password-file=${passFile}`);
				if (decrypt && !isCheck) argv.push('--decrypt');
			}
			argv.push(inFile);
			if (!isCheck) argv.push(outFile);

			capture = [];
			let code;
			try {
				code = mod.callMain(argv);
			} finally {
				const lines = capture ?? [];
				capture = null;
				diagnostics = lines.join('\n');
			}

			if (isCheck) return { code, out: null, diagnostics };

			if (code !== EXIT_OK && code !== EXIT_WARN) return { code, out: null, diagnostics };
			try {
				// Detach from the WASM heap before anything can reuse it.
				const view = mod.FS.readFile(outFile);
				const copy = new Uint8Array(new ArrayBuffer(view.length));
				copy.set(view);
				return { code, out: copy, diagnostics };
			} catch {
				return { code, out: null, diagnostics };
			}
		} catch (err) {
			return {
				code: -1,
				out: null,
				diagnostics: err instanceof Error ? err.message : String(err)
			};
		} finally {
			cleanup(mod, inFile, isCheck ? null : outFile, passFile);
		}
	};
}

/**
 * Inflate/deflate, for images stored Flate-wrapped around a JPEG.
 *
 * Node/Bun have zlib built in. The browser worker does not, so it passes null
 * and the engine skips those images rather than corrupting them.
 */
export function makeZip() {
	return {
		inflate: async (data) => new Uint8Array(zlib.inflateSync(Buffer.from(data))),
		deflate: async (data) => new Uint8Array(zlib.deflateSync(Buffer.from(data), { level: 9 }))
	};
}
 /**
 * jSquash-backed ImageCodec.
 *
 * jSquash takes and returns ArrayBuffers and uses an options *object*, and its
 * `encode` result must be measured with `.byteLength` rather than `.length` -
 * getting that wrong silently reports every image as huge.
 */
export async function makeCodec() {
	// `@jsquash/jpeg` uses named exports; `@jsquash/resize` exposes its
	// function as the default export (plus init* helpers). Importing `resize`
	// as a named export yields undefined and every downscale throws.
	const [{ decode, encode }, resizeModule] = await Promise.all([
		import('@jsquash/jpeg'),
		import('@jsquash/resize')
	]);
	const resize = resizeModule.default;

	const toBuf = (u8) =>
		u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
			? u8.buffer
			: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

	return {
		async decode(jpeg) {
			return await decode(toBuf(jpeg));
		},
		async encode(image, quality) {
			return new Uint8Array(await encode(image, { quality }));
		},
		async resize(image, width, height) {
			return await resize(image, { width, height });
		}
	};
}