import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("../fixtures/wormholeRefundReadsScenario.ts", import.meta.url)
);
const scenarios: Record<string, string> = {
  "third-party": "origin proof permits finish with unavailable destination history and route",
  slow: "expired slow refund never reads remote readiness, origin proof or Scan",
  "exact-map": "nonzero but wrong bidirectional maps cannot start publication or proof delivery",
  "retry-route": "an unavailable deployment is rechecked rather than cached forever",
  recovered: "verified non-fill publication resumes proof instead of publication",
  "history-error": "failed history recovery cannot authorize a fresh publication",
  "transport-error": "failed Scan recovery cannot authorize a fresh publication",
  filled: "one filled output vetoes every fast action despite existing proof",
  unreadable: "an unreadable signed output vetoes every action despite existing proof",
  missing: "an unsupported output cannot be omitted from the action guard",
  delivered: "API Delivered metadata vetoes every action despite existing proof",
  settled: "API Settled metadata vetoes every action despite existing proof",
  "settled-tx": "known settlement transaction skips remote reads and vetoes every action",
  "solana-window":
    "fresh finalized destination time disables an absent record outside the mint window",
  "solana-current": "an existing current Solana record remains publishable after the mint window",
  "solana-clock": "an unavailable finalized Solana clock cannot enable publication",
  "solana-window-boundary":
    "minting remains eligible at the exact finalized-window margin boundary",
  "solana-deadline": "browser time past deadline cannot override finalized time at the deadline",
  "solana-clock-lag": "stale finalized time cannot enable publication of a current record",
  "solana-afterwallet-window":
    "record guard catches mint-window crossing after wallet preparation without blocking proof registration"
};

describe("Wormhole refund reads and pre-spend eligibility", () => {
  for (const [scenario, description] of Object.entries(scenarios)) {
    test(
      description,
      async () => {
        // Process isolation keeps Bun module mocks out of real protocol suites.
        const child = Bun.spawn([process.execPath, "run", fixture, scenario], {
          stdout: "pipe",
          stderr: "pipe"
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text()
        ]);
        expect({ code, output: stdout + stderr }).toEqual({ code: 0, output: "" });
      },
      15_000
    );
  }
});
