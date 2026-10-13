import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../fixtures/wormholeFillScenario.ts", import.meta.url));
const scenarios: Record<string, string> = {
  "pending-retry": "pending keeps one publication and never marks intermediate success",
  "transport-retry": "Scan transport retry reuses the destination publication",
  "wallet-retry": "rejected origin signing resumes delivery without republishing",
  "third-party": "already registered origin proof skips every wallet and Scan action",
  "two-wallets": "Solana origin uses the output EVM wallet then real Solana delivery stages",
  "malformed-bound-proof": "altered fill solver is rejected before a wallet prompt",
  "receipt-without-proof": "a successful receive receipt without origin proof cannot complete",
  "solana-stage-failure": "failed Core posting never marks proof registered or green",
  "solana-publication-singleflight":
    "concurrent multichain inputs consume one Solana local fill record",
  "delivery-singleflight": "concurrent receives of one input VAA send only one registration",
  "unavailable-route": "unavailable route prevents wallet preparation and publication"
};

describe("Wormhole fill proof flow", () => {
  for (const [scenario, description] of Object.entries(scenarios)) {
    test(
      description,
      async () => {
        // Bun module mocks are process-global; keep orchestration fixtures away
        // from the suites exercising real Scan, publication and Solana Core code.
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
