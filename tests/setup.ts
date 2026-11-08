import { mock } from "bun:test";

// SvelteKit provides these virtual modules at runtime. Unit tests stay off the network
// and out of the browser, so both resolve to empty public config and `browser: false`.
mock.module("$env/dynamic/public", () => ({ env: {} }));
mock.module("$app/environment", () => ({
  browser: false,
  building: false,
  dev: true,
  version: "test"
}));
