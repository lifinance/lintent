import { mock } from "bun:test";

// SvelteKit provides this virtual module at runtime; unit tests are public-config-free.
mock.module("$env/dynamic/public", () => ({ env: {} }));
