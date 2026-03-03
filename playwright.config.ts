import { defineConfig, devices } from "@playwright/test";

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
		timeout: 120_000
	}
});
