/**
 * QPDF options, restricted to what the vendored WASM build (qpdf 12.4.2)
 * actually accepts. Every flag here was exercised in
 * `scripts/test-compression.mjs` against the real engine.
 */

export type Mode = 'compress' | 'linearize';

export interface CompressOptions {
	mode: Mode;
	/** --object-streams=generate|preserve|disable */
	objectStreams: 'generate' | 'preserve' | 'disable';
	/** --compression-level=0..9 (zlib deflate level) */
	compressionLevel: number;
	/** --recompress-flate : re-encode already-Flate streams */
	recompressFlate: boolean;
	/** --stream-data=compress|uncompress|preserve */
	streamData: 'compress' | 'uncompress' | 'preserve';
	/** --decode-level=none|generalized|specialized|all */
	decodeLevel: 'none' | 'generalized' | 'specialized' | 'all';
}

export const DEFAULT_OPTIONS: CompressOptions = {
	mode: 'compress',
	objectStreams: 'generate',
	compressionLevel: 9,
	recompressFlate: true,
	streamData: 'compress',
	decodeLevel: 'generalized'
};

export interface ProcessRequest {
	options: CompressOptions;
	/** Empty string means "no password". */
	password: string;
}

/**
 * Build the qpdf argv for a run.
 *
 * Always uses `--warning-exit-0` so that a document with recoverable warnings
 * still counts as success (exit 3 would otherwise look like a failure).
 */
export function buildArgs(options: CompressOptions): string[] {
	const args = ['--no-warn', '--warning-exit-0'];

	if (options.mode === 'linearize') {
		args.push('--linearize');
		return args;
	}

	args.push(
		`--object-streams=${options.objectStreams}`,
		`--compression-level=${clampLevel(options.compressionLevel)}`,
		`--stream-data=${options.streamData}`,
		`--decode-level=${options.decodeLevel}`
	);

	if (options.recompressFlate) args.push('--recompress-flate');

	return args;
}

function clampLevel(level: number): number {
	if (!Number.isFinite(level)) return 9;
	return Math.min(9, Math.max(0, Math.round(level)));
}