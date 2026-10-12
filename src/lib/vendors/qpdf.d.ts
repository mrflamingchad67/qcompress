/**
 * Types for the vendored Emscripten glue.
 *
 * `qpdf.js` is a `--closure 1` minified build, so it is excluded from
 * type-checking and described here instead. Only the surface this app uses is
 * declared.
 */

export interface QpdfFs {
	writeFile(path: string, data: Uint8Array): void;
	readFile(path: string): Uint8Array;
	unlink(path: string): void;
	stat(path: string): { size: number };
}

export interface QpdfModule {
	FS: QpdfFs;
	/** Runs qpdf with argv. Returns the process exit code. */
	callMain(args: string[]): number;
	ENV: Record<string, boolean>;
}

export interface QpdfFactoryOptions {
	noInitialRun?: boolean;
	/** Receives qpdf's stdout lines. */
	print?: (line: string) => void;
	/** Receives qpdf's stderr lines. */
	printErr?: (line: string) => void;
	/** Resolve the .wasm URL. */
	locateFile?: (path: string) => string;
}

declare function createModule(options?: QpdfFactoryOptions): Promise<QpdfModule>;

export default createModule;