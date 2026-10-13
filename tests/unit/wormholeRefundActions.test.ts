import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("../fixtures/wormholeRefundActionsScenario.ts", import.meta.url)
);
const flowFixture = fileURLToPath(
  new URL("../fixtures/wormholeRefundFlowScenario.ts", import.meta.url)
);
const scenarios: Record<string, string> = {
  "publish-reuse": "verified publication is reused without a second destination spend",
  "pending-transport-resume":
    "pending and Scan transport failures retain the same verified publication",
  "source-unverified": "unverified source never polls or prompts a wallet",
  "fabricated-deadline":
    "a VAA for a fabricated deadline cannot register the signed non-fill proof",
  "third-party": "existing origin proof skips publication, Scan and receive",
  "third-party-wallet": "third-party delivery during wallet preparation skips the receive spend",
  "record-wallet-fill":
    "an output filled during publication wallet preparation prevents publication",
  "receive-wallet-fill": "an output filled during receive wallet preparation prevents registration",
  "receive-simulation-fill": "an output filled during receive simulation prevents registration",
  "fast-wallet-fill": "final refund rechecks every output after wallet preparation",
  "slow-wallet-fill": "slow Wormhole refund also rechecks after wallet preparation",
  "expiry-buffer": "crossing the start buffer during polling prevents a new receive fee",
  "expiry-finish": "confirmed proof permits finish-only refund inside the start buffer",
  "receipt-without-proof":
    "confirmed receive without origin proof never reports registration success",
  "solana-stage-fill": "a fill between Core stages prevents every subsequent transaction",
  "solana-stage-proof": "third-party proof between Core stages skips subsequent transactions",
  "solana-stage-failure": "failed Core posting never reports proof delivery success",
  "solana-final-fill": "Solana final refund applies its guard at the real beforeSign boundary",
  "solana-publish": "Solana non-fill publication uses the signed deadline and state PDA",
  "slow-unavailable": "slow refund needs neither route readiness nor Scan",
  polymer: "Polymer publication and proof dispatch retain their existing entrypoints",
  "decoded-error": "Wormhole simulation errors preserve decoded guardian and payload failures",
  "flow-read-failure": "a failed fresh refresh retains the snapshot but disables all spending",
  "flow-stale-refresh": "superseded refreshes cannot replace a newer snapshot",
  "flow-pending-resume":
    "pending and failed Core stages retain the publication and show actual substeps",
  "flow-terminal-hints": "terminal refresh clears only this signed order's exact non-fill hint"
};
for (const veto of [
  "filled",
  "unknown",
  "missing",
  "Delivered",
  "Settled",
  "delivery-tx",
  "settlement-tx"
]) {
  scenarios[`veto-${veto}`] = `${veto} blocks every Wormhole spend despite an attested rail`;
}

describe("Wormhole refund actions", () => {
  for (const [scenario, description] of Object.entries(scenarios)) {
    test(
      description,
      async () => {
        // Module mocks are isolated from suites exercising actual publication,
        // guardian verification and route reads in the main test process.
        const child = Bun.spawn(
          [process.execPath, "run", scenario.startsWith("flow-") ? flowFixture : fixture, scenario],
          {
            stdout: "pipe",
            stderr: "pipe"
          }
        );
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
