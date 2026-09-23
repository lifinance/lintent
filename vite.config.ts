import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [tailwindcss(), sveltekit()],
  envPrefix: ["VITE_", "PUBLIC_"],
  server: mode === "test" ? { fs: { allow: ["tests"] } } : undefined,
  optimizeDeps: {
    exclude: ["@electric-sql/pglite"]
  }
}));
