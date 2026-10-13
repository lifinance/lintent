import { describe, expect, test } from "bun:test";
import {
  addressToBytes32,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_POLYMER_ORACLE_PROGRAM,
  type MandateOutput
} from "@lifi/intent";
import {
  COIN_FILLER,
  INPUT_SETTLER_ESCROW_LIFI,
  POLYMER_ORACLE,
  SOLANA_OUTPUT_SETTLER,
  WORMHOLE_ORACLE
} from "../../src/lib/config";
import type { EscrowRefundOrder } from "../../src/lib/libraries/refundLookup";
import {
  deriveRefundView,
  preSpendVerdict,
  selectFastRail,
  type FastProgress,
  type OutputFill,
  type RefundSnapshot,
  type SpendMode
} from "../../src/lib/libraries/refundState";
import { makeStandardOrder, makeMandateOutput, b32 } from "../fixtures/orderFixtures";

const DEADLINE = 1700000000;
const EXPIRES = DEADLINE + 20000;
const NOW = DEADLINE + 1;
function output(chainId = 42161n, overrides: Partial<MandateOutput> = {}): MandateOutput {
  return makeMandateOutput(chainId, 1000000n, {
    oracle: addressToBytes32(WORMHOLE_ORACLE[Number(chainId)]!),
    settler:
      chainId === SOLANA_MAINNET_CHAIN_ID ? SOLANA_OUTPUT_SETTLER : addressToBytes32(COIN_FILLER),
    ...overrides
  });
}
function order(outputs = [output()], origin = 8453n): EscrowRefundOrder {
  const standard = makeStandardOrder({
    originChainId: origin,
    inputOracle: WORMHOLE_ORACLE[Number(origin)]!,
    outputs,
    fillDeadline: DEADLINE,
    expires: EXPIRES
  });
  const container = {
    order: standard,
    inputSettler: INPUT_SETTLER_ESCROW_LIFI,
    sponsorSignature: { type: "None" as const, payload: "0x" as const },
    allocatorSignature: { type: "None" as const, payload: "0x" as const }
  };
  return {
    order: standard,
    container,
    orderId: b32("a"),
    legacySettler: false,
    meta: {
      onChainOrderId: b32("a"),
      orderStatus: "Signed",
      orderInitiatedTxHash: null,
      orderDeliveredTxHash: null,
      orderSettledTxHash: null,
      refundTxHash: null
    }
  };
}
function progress(o: EscrowRefundOrder, attested = false): FastProgress {
  const rail = selectFastRail(o);
  if ("reason" in rail) throw new Error(rail.reason);
  return { rail, attested, source: null };
}
function snapshot(o: EscrowRefundOrder, overrides: Partial<RefundSnapshot> = {}): RefundSnapshot {
  return {
    escrow: "deposited",
    outputs: o.order.outputs.map(() => "unfilled"),
    fast: progress(o),
    ...overrides
  };
}

describe("Wormhole refund rail identity", () => {
  test("distinct EVM deployments select the destination oracle, not padded input equality", () => {
    const o = order();
    const rail = selectFastRail(o);
    expect(rail).toMatchObject({ provider: "wormhole", outputIndex: 0, destKind: "evm" });
    expect(o.order.outputs[0]!.oracle.toLowerCase()).not.toBe(
      addressToBytes32(o.order.inputOracle).toLowerCase()
    );
    expect(
      selectFastRail(order([output(42161n, { oracle: addressToBytes32(o.order.inputOracle) })]))
    ).toEqual({ reason: "no-provable-output" });
  });
  test("Base to Solana requires state PDA, not Polymer program consumer", () => {
    expect(selectFastRail(order([output(SOLANA_MAINNET_CHAIN_ID)]))).toMatchObject({
      provider: "wormhole",
      destKind: "solana"
    });
    expect(
      selectFastRail(
        order([output(SOLANA_MAINNET_CHAIN_ID, { oracle: SOLANA_POLYMER_ORACLE_PROGRAM })])
      )
    ).toEqual({ reason: "no-provable-output" });
  });
  test("Solana to Base uses the Base deployment", () => {
    expect(selectFastRail(order([output(8453n)], SOLANA_MAINNET_CHAIN_ID))).toMatchObject({
      provider: "wormhole",
      destKind: "evm"
    });
  });
  test("mixed providers or dirty destination identity cannot become a fast rail", () => {
    expect(
      selectFastRail(
        order([output(), output(1n, { oracle: addressToBytes32(POLYMER_ORACLE[1]!) })])
      )
    ).toEqual({ reason: "no-provable-output" });
    expect(selectFastRail(order([output(42161n, { oracle: b32("f") })]))).toEqual({
      reason: "no-provable-output"
    });
    const o = order();
    o.order.inputOracle = b32("f");
    expect(selectFastRail(o)).toEqual({ reason: "unsupported-input-oracle" });
  });
});

describe("all-output and API vetoes precede every refund spend", () => {
  const modes: SpendMode[] = ["record", "prove", "fast", "slow"];
  test.each(["filled", "unknown"] as const)(
    "one %s output blocks even a valid existing proof",
    (state) => {
      const o = order([output(), output(1n)]);
      for (const mode of modes) {
        expect(
          preSpendVerdict(
            o,
            mode,
            { escrow: "deposited", outputs: ["unfilled", state], attested: true },
            mode === "slow" ? EXPIRES + 1 : NOW
          )
        ).toHaveProperty("blocked");
      }
    }
  );
  test("short, empty and sparse fresh snapshots never permit spending or show actionable refund", () => {
    const o = order([output(), output(1n)]);
    const sparse: OutputFill[] = [];
    sparse.length = 2;
    sparse[0] = "unfilled";
    for (const outputs of [[], ["unfilled"] as OutputFill[], sparse]) {
      for (const mode of modes)
        expect(
          preSpendVerdict(o, mode, { escrow: "deposited", outputs, attested: true }, EXPIRES + 1)
        ).toHaveProperty("blocked");
      expect(
        deriveRefundView(o, snapshot(o, { outputs, fast: progress(o, true) }), EXPIRES + 1)?.kind
      ).toBe("fill-unverifiable");
    }
  });
  test.each(["Delivered", "Settled"])(
    "known API %s veto survives action-time chain reads",
    (status) => {
      const o = order();
      o.meta.orderStatus = status;
      for (const mode of modes)
        expect(
          preSpendVerdict(
            o,
            mode,
            { escrow: "deposited", outputs: ["unfilled"], attested: true },
            EXPIRES + 1
          )
        ).toHaveProperty("blocked");
      expect(deriveRefundView(o, snapshot(o), NOW)?.kind).toBe("filled");
    }
  );
  test("known delivery transaction also vetoes a contradictory unfilled snapshot", () => {
    const o = order();
    o.meta.orderDeliveredTxHash = b32("d");
    expect(
      preSpendVerdict(
        o,
        "record",
        { escrow: "deposited", outputs: ["unfilled"], attested: false },
        NOW
      )
    ).toHaveProperty("blocked");
  });
  test("known settlement transaction vetoes even without a parsed terminal status", () => {
    const o = order();
    o.meta.orderSettledTxHash = b32("d");
    o.meta.orderStatus = null;
    expect(
      preSpendVerdict(
        o,
        "fast",
        { escrow: "deposited", outputs: ["unfilled"], attested: true },
        NOW
      )
    ).toHaveProperty("blocked");
    expect(deriveRefundView(o, snapshot(o), NOW)?.kind).toBe("filled");
  });
});

describe("Wormhole refund timing and fallback", () => {
  const fresh = { escrow: "deposited" as const, outputs: ["unfilled" as const], attested: false };
  test("deadline and start buffer remain strict; existing proof permits finish-only", () => {
    const o = order();
    expect(preSpendVerdict(o, "record", fresh, DEADLINE)).toHaveProperty("blocked");
    expect(preSpendVerdict(o, "record", fresh, DEADLINE + 1)).toBe("go");
    expect(preSpendVerdict(o, "record", fresh, EXPIRES - 7200)).toHaveProperty("blocked");
    expect(preSpendVerdict(o, "record", fresh, EXPIRES - 7201)).toBe("go");
    expect(preSpendVerdict(o, "prove", { ...fresh, attested: true }, EXPIRES - 7200)).toBe(
      "already-proven"
    );
    expect(preSpendVerdict(o, "fast", { ...fresh, attested: true }, EXPIRES - 1)).toBe("go");
    expect(preSpendVerdict(o, "fast", { ...fresh, attested: true }, EXPIRES)).toHaveProperty(
      "blocked"
    );
  });
  test("slow refund ignores unavailable remote route but must pass expiry", () => {
    const o = order();
    const snap: RefundSnapshot = {
      escrow: "deposited",
      outputs: ["unfilled"],
      fast: { unavailable: "wormhole-route-unavailable" }
    };
    expect(deriveRefundView(o, snap, EXPIRES)?.kind).toBe("waiting-expiry");
    expect(deriveRefundView(o, snap, EXPIRES + 1)?.kind).toBe("slow");
    expect(preSpendVerdict(o, "slow", fresh, EXPIRES)).toHaveProperty("blocked");
    expect(preSpendVerdict(o, "slow", fresh, EXPIRES + 1)).toBe("go");
  });
  test("Solana-to-Solana slow grace boundary is retained independent of provider", () => {
    const o = order([output(SOLANA_MAINNET_CHAIN_ID)], SOLANA_MAINNET_CHAIN_ID);
    const snap: RefundSnapshot = {
      escrow: "deposited",
      outputs: ["unfilled"],
      fast: { unavailable: "same-chain" }
    };
    expect(preSpendVerdict(o, "slow", fresh, EXPIRES + 900)).toHaveProperty("blocked");
    expect(preSpendVerdict(o, "slow", fresh, EXPIRES + 901)).toBe("go");
    expect(deriveRefundView(o, snap, EXPIRES + 900)?.kind).toBe("waiting-expiry");
    expect(deriveRefundView(o, snap, EXPIRES + 901)?.kind).toBe("slow");
  });
});
