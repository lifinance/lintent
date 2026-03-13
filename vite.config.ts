import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import inject from "@rollup/plugin-inject";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	resolve: {
		alias: {
			// Use the CJS browser bundle to avoid ESM named-import issues with borsh@0.7
			"@solana/web3.js": "@solana/web3.js/lib/index.browser.cjs.js"
		}
	},
	optimizeDeps: {
		exclude: ["@electric-sql/pglite"],
		include: ["buffer"]
	},
	build: {
		rollupOptions: {
			plugins: [inject({ Buffer: ["buffer", "Buffer"] })]
		}
	},
	define: {
		// Polyfill Buffer for Solana web3.js in the browser
		global: "globalThis"
	}
});
