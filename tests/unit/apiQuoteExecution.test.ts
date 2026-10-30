import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import type { ExecutionWindow, SelectionMutation } from "../fixtures/apiQuoteExecution";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/apiQuoteExecution.ts", import.meta.url));
async function execute(window: ExecutionWindow, mutation: SelectionMutation) {
  const child = Bun.spawn([process.execPath, "--no-env-file", fixture, window, mutation], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp"
    },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (exit !== 0) throw new Error(`Execution fixture failed (${exit}): ${stderr}\n${stdout}`);
  return JSON.parse(stdout) as {
    rejected: boolean;
    error?: string;
    approvalSignings: number;
    openSignings: number;
    payloadPreserved: boolean;
  };
}

describe("API quote revocation during actual deferred execution", () => {
  for (const window of ["approval", "stellar-prepare"] as const) {
    for (const mutation of ["clear", "replace", "generation", "output", "round-trip"] as const) {
      it(`${window}: ${mutation} prevents signing the stale open`, async () => {
        const result = await execute(window, mutation);
        expect(result.rejected).toBe(true);
        expect(result.error).toMatch(/selection|output amount/i);
        expect(result.openSignings).toBe(0);
      });
    }
    it(`${window}: unchanged selection opens with the exact returned payload after placeholder selection`, async () => {
      const result = await execute(window, "unchanged");
      expect(result.rejected).toBe(false);
      expect(result.openSignings).toBe(1);
      expect(result.payloadPreserved).toBe(true);
    });
  }
  it("invalidation during the allowance read prevents even approval signing", async () => {
    const result = await execute("allowance-read", "clear");
    expect(result.rejected).toBe(true);
    expect(result.approvalSignings).toBe(0);
    expect(result.openSignings).toBe(0);
  });
  it("output editing during the last EVM wallet check prevents open signing", async () => {
    const result = await execute("wallet-recheck", "output");
    expect(result.rejected).toBe(true);
    expect(result.openSignings).toBe(0);
  });
  it("invalidation during Freighter network preparation prevents Stellar signing", async () => {
    const result = await execute("stellar-network", "clear");
    expect(result.rejected).toBe(true);
    expect(result.openSignings).toBe(0);
  });
});
