import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  envPrefix: ["VITE_", "PUBLIC_"],
  optimizeDeps: {
    exclude: ["@electric-sql/pglite"]
  }
});
