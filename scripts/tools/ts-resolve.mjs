/**
 * Node resolver hook: extensionless relative imports -> .ts / .js
 *
 * Bun resolves `./bytes` to `./bytes.ts` automatically. Node does not, so this
 * lets the same source run under Node - which is what makes Node's V8 heap
 * accounting available for measurement. Bun's heap could not see the large
 * string allocations this project is trying to account for.
 *
 * Register with: node --import ./scripts/tools/ts-resolve.mjs <script>
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];

export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (err) {
		const relative = specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier);
		if (!relative || !context.parentURL) throw err;

		for (const ext of EXTENSIONS) {
			const candidate = new URL(specifier + ext, context.parentURL);
			if (existsSync(fileURLToPath(candidate))) {
				return { url: candidate.href, shortCircuit: true };
			}
		}
		throw err;
	}
}