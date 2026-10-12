import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			preprocess: vitePreprocess(),
			// Pure client-side app: no server, no API routes, nothing to upload to.
			adapter: adapter({
				fallback: undefined,
				precompress: false,
				strict: true
			})
		})
	],
	build: {
		target: 'es2022'
	},
	worker: {
		format: 'es'
	}
});