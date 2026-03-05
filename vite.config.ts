import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import inject from "@rollup/plugin-inject";

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		inject({
			Buffer: ["buffer", "Buffer"]
		})
	],
	optimizeDeps: {
		exclude: ["@electric-sql/pglite"],
		include: ["buffer"]
	}
});
