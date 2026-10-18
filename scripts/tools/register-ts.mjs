/**
 * Register the TypeScript resolver hook.
 * Used as: node --import ./scripts/tools/register-ts.mjs <entry>
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-resolve.mjs', pathToFileURL(import.meta.filename ?? import.meta.url));