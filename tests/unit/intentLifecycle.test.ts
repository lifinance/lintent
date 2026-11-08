import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/intentLifecycle.ts", import.meta.url));

type LifecycleReport = {
  expiredQuoteError: string;
  expiredQuoteExecute: string;
  expiredIntentError: string;
  expiredIntentExecute: string;
  opensAfterExpiry: number;
  staleApplied: boolean;
  freshApplied: boolean;
  selectedQuoteId: string;
  staleExecute: string;
  opensAfterStale: number;
  stages: string[];
  open: { contract: string; method: string; arg: string };
  freshPayload: string;
  fill: { address: string; orderId: string; fillDeadline: number; solver: string };
  expectedSolver: string;
  expectedOrderId: string;
  proof: { to: string; value: string; destination: string; recipient: string; selector: string };
  finalise: { contract: string; method: string };
  proved: boolean;
  corridor: { origin: number; destination: number; escrow: string; generation: string };
};

async function runLifecycle() {
  const child = Bun.spawn([process.execPath, "--no-env-file", fixture], {
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
  if (exit !== 0) throw new Error(`Lifecycle fixture failed (${exit}): ${stderr}\n${stdout}`);
  return JSON.parse(stdout) as LifecycleReport;
}

describe("Stellar-EVM testnet intent lifecycle", () => {
  it("locks, issues, solves, proves and finalises, and rejects a stale quote or an expired intent", async () => {
    const report = await runLifecycle();

    expect(report.expiredQuoteError).toMatch(/expired/i);
    expect(report.expiredQuoteExecute).toMatch(/expired/i);
    expect(report.expiredIntentError).toMatch(/differs|expired/i);
    expect(report.expiredIntentExecute).toMatch(/differs|expired/i);
    expect(report.opensAfterExpiry).toBe(0);

    expect(report.staleApplied).toBe(false);
    expect(report.freshApplied).toBe(true);
    expect(report.selectedQuoteId).toBe("fresh-quote");
    expect(report.staleExecute).toMatch(/selection changed/i);
    expect(report.opensAfterStale).toBe(0);

    expect(report.corridor).toEqual({
      origin: 1201081091099711,
      destination: 84532,
      escrow: "CBA4VPFFOASNKUN4EXC2YLSIWCWUATLDVGVCSZP4ZLDTANGFE6KWXYV5",
      generation: "current"
    });
    expect(report.stages).toEqual(["lock", "issue", "solve", "proof", "finalise"]);
    expect(report.open).toMatchObject({
      contract: report.corridor.escrow,
      method: "open",
      arg: report.freshPayload
    });
    expect(report.fill.orderId).toBe(report.expectedOrderId);
    expect(report.fill.solver).toBe(report.expectedSolver);
    expect(report.fill.fillDeadline).toBe(1_800_003_000);
    expect(report.fill.address.toLowerCase()).toBe("0x75220b7600c300005038432a0000f308e0000068");
    expect(report.proof.selector).toBe("0xd5434caa");
    expect(report.proof.destination).toBe("stellar-2026-q1-2");
    expect(report.proof.recipient).toBe("CC7DG7L35SLE7MALNEG6QJAKG6GJNCQIIGVBA63HQ26XHEBRKBHO246J");
    expect(report.proof.value).toBe("1000");
    expect(report.proof.to.toLowerCase()).toBe("0x7bec62dd796b39ac36bbdc8a8470a77cae5c8716");
    expect(report.proved).toBe(true);
    expect(report.finalise).toMatchObject({
      contract: report.corridor.escrow,
      method: "finalise"
    });
  });
});
