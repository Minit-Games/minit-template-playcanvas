import { defineConfig } from 'vite';

export default defineConfig({
	// Vite emits absolute asset URLs by default. The app does not serve the
	// game from a domain root -- on iOS it is behind the minitlocal:// custom
	// scheme -- so an absolute path resolves to nothing and the page is blank.
	base: './',

	build: {
		target: ['es2020', 'safari15'],
		assetsInlineLimit: 4096,
		// The modulepreload polyfill calls fetch(), which the sandbox forbids
		// and the platform's validation sweep greps for.
		modulePreload: false,
		rollupOptions: {
			output: { manualChunks: undefined, inlineDynamicImports: true },
		},
	},

	plugins: [
		{
			// Vite marks the entry script crossorigin, turning it into a
			// CORS-checked fetch. Under minitlocal:// the document has an
			// opaque origin, so that check cannot pass and the script silently
			// never runs.
			name: 'minit-strip-crossorigin',
			enforce: 'post',
			transformIndexHtml: (html) => html.replace(/\s+crossorigin(=["'][^"']*["'])?/g, ''),
		},
	],
});
