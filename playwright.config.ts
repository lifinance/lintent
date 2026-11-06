import { existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// `bun --bun run test:e2e` (opt-in) puts a `node` -> bun shim on PATH. Drop that
// directory so the webServer (vite, node shebang) runs on real Node.
const runtime = realpathSync(process.execPath);
const nodePath = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((dir) => {
    if (!process.versions.bun) return true;
    const candidate = join(dir, "node");
    return !(existsSync(candidate) && realpathSync(candidate) === runtime);
  })
  .join(delimiter);

export default defineConfig({
  testDir: "tests/e2e",
  reporter: [["line"], ["html", { open: "never" }]],
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    video: process.env.PW_VIDEO_ALL ? "on" : "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: "bunx vite dev --force --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ...process.env, PATH: nodePath } as Record<string, string>
  }
});
