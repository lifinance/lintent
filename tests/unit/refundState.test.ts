import { describe, expect, mock, test } from "bun:test";
import {
  addressToBytes32,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_OUTPUT_SETTLER_PDA,
  SOLANA_POLYMER_ORACLE_PDA,
  SOLANA_POLYMER_ORACLE_PROGRAM,
  TRON_MAINNET_CHAIN_ID,
  type MandateOutput,
  type StandardOrder
} from "@lifi/intent";
import type { EscrowRefundOrder, RefundOrderMeta } from "../../src/lib/libraries/refundLookup";
import type {
  EscrowState,
  FastProgress,
  OutputFill,
  RefundSnapshot
} from "../../src/lib/libraries/refundState";

// refundLookup (imported by refundState for REFUND_CHAIN_IDS) pulls in the
// Tron/Solana clients, which read SvelteKit's `$app/environment`; bun can't
// resolve it, so stub it before the dynamic import.
mock.module("$app/environment", () => ({ browser: false }));
const { deriveRefundView, matchesNotFilledLog, preSpendVerdict, selectFastRail } = await import(
  "../../src/lib/libraries/refundState"
);

const POLYMER = "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17" as const;
const COIN_FILLER = "0x75220B7600c300005038432a0000f308e0000068" as const;
const ORDER_ID = `0x${"ab".repeat(32)}` as const;
const BASE = 8453n;
const ARBITRUM = 42161n;
const SOLANA = SOLANA_MAINNET_CHAIN_ID;
const FILL_DEADLINE = 1_000_000;
const EXPIRES = FILL_DEADLINE + 48 * 3600;

const output = (over: Partial<MandateOutput> = {}): MandateOutput => ({
  oracle: addressToBytes32(POLYMER),
  settler: addressToBytes32(COIN_FILLER),
  chainId: ARBITRUM,
  token: `0x${"11".repeat(32)}`,
  amount: 1_000_000n,
  recipient: `0x${"22".repeat(32)}`,
  callbackData: "0x",
  context: "0x",
  ...over
});

const meta = (over: Partial<RefundOrderMeta> = {}): RefundOrderMeta => ({
  onChainOrderId: ORDER_ID,
  orderStatus: "Signed",
  orderInitiatedTxHash: null,
  orderDeliveredTxHash: null,
  orderSettledTxHash: null,
  refundTxHash: null,
  ...over
});

const makeOrder = (
  over: Partial<StandardOrder> = {},
  extra: Partial<EscrowRefundOrder> = {}
): EscrowRefundOrder => {
  const order = {
    user: `0x${"33".repeat(20)}`,
    nonce: 1n,
    originChainId: BASE,
    expires: EXPIRES,
    fillDeadline: FILL_DEADLINE,
    inputOracle: POLYMER,
    inputs: [[1n, 1n]],
    outputs: [output()],
    ...over
  } as StandardOrder;
  return {
    orderId: ORDER_ID,
    container: { inputSettler: "0x00", order, sponsorSignature: {}, allocatorSignature: {} },
    order,
    meta: meta(),
    legacySettler: false,
    ...extra
  } as unknown as EscrowRefundOrder;
};

const railOf = (order: EscrowRefundOrder) => {
  const rail = selectFastRail(order);
  if ("reason" in rail) throw new Error(rail.reason);
  return rail;
};

const progress = (order: EscrowRefundOrder, over: Partial<FastProgress> = {}): FastProgress => ({
  rail: railOf(order),
  attested: false,
  source: null,
  ...over
});

const snap = (over: Partial<RefundSnapshot> = {}): RefundSnapshot => ({
  escrow: "deposited",
  outputs: ["unfilled"],
  fast: null,
  ...over
});

const FAST_WINDOW = FILL_DEADLINE + 3600;
const EVM_SOURCE = {
  kind: "evm",
  chainId: 42161,
  blockNumber: 1n,
  logIndex: 0,
  txHash: `0x${"cd".repeat(32)}`
} as const;

describe("deriveRefundView precedence (plan §4.2)", () => {
  const order = makeOrder();

  test("row 0: unsupported short-circuits everything", () => {
    const view = deriveRefundView(
      { ...order, unsupported: "compact" } as never,
      snap({ escrow: "refunded" }),
      0
    );
    expect(view).toEqual({ kind: "unsupported", reason: "compact" });
  });

  test("rows 1-4: escrow states", () => {
    expect(deriveRefundView(order, snap({ escrow: "none" }), 0)?.kind).toBe("not-opened");
    expect(deriveRefundView(order, snap({ escrow: "refunded" }), 0)?.kind).toBe("refunded");
    expect(deriveRefundView(order, snap({ escrow: "claimed" }), 0)?.kind).toBe("claimed");
    expect(deriveRefundView(order, snap({ escrow: "closed" }), 0)?.kind).toBe("settled");
  });

  test("Solana closed context is told apart by API hints", () => {
    const refunded = makeOrder({}, { meta: meta({ refundTxHash: "sig" }) });
    expect(deriveRefundView(refunded, snap({ escrow: "closed" }), 0)).toEqual({
      kind: "refunded",
      refundTx: "sig"
    });
    const settled = makeOrder({}, { meta: meta({ orderSettledTxHash: "sig" }) });
    expect(deriveRefundView(settled, snap({ escrow: "closed" }), 0)?.kind).toBe("claimed");
  });

  test("row 5: a filled output beats an expired order", () => {
    expect(deriveRefundView(order, snap({ outputs: ["filled"] }), EXPIRES + 1)).toEqual({
      kind: "filled",
      outputIndexes: [0]
    });
  });

  test("row 5: API Delivered blocks even when the chain says unfilled", () => {
    const delivered = makeOrder({}, { meta: meta({ orderStatus: "Delivered" }) });
    expect(deriveRefundView(delivered, snap(), EXPIRES + 1)?.kind).toBe("filled");
    const hashOnly = makeOrder({}, { meta: meta({ orderDeliveredTxHash: "0x1" }) });
    expect(deriveRefundView(hashOnly, snap(), EXPIRES + 1)?.kind).toBe("filled");
  });

  test("row 7: expired beats a half-done (even attested) fast refund", () => {
    const fast = progress(order, { attested: true });
    expect(deriveRefundView(order, snap({ fast }), EXPIRES + 1)).toEqual({ kind: "slow" });
    expect(deriveRefundView(order, snap({ fast }), EXPIRES)?.kind).toBe("fast");
  });

  test("rows 7-8: Solana→Solana waits out the 900s grace", () => {
    const solana = makeOrder({
      originChainId: SOLANA,
      inputOracle: SOLANA_POLYMER_ORACLE_PDA,
      outputs: [output({ chainId: SOLANA })]
    });
    expect(deriveRefundView(solana, snap(), EXPIRES + 1)).toEqual({
      kind: "waiting-expiry",
      slowAt: EXPIRES + 900,
      fastReason: "solana-to-solana"
    });
    expect(deriveRefundView(solana, snap(), EXPIRES + 901)?.kind).toBe("slow");
  });

  test("row 9: before fillDeadline, fastAt only when fast is possible", () => {
    expect(deriveRefundView(order, snap({ fast: progress(order) }), FILL_DEADLINE)).toEqual({
      kind: "waiting-fill-deadline",
      fastAt: FILL_DEADLINE,
      slowAt: EXPIRES
    });
    expect(
      deriveRefundView(order, snap({ fast: { unavailable: "same-chain" } }), FILL_DEADLINE)
    ).toEqual({ kind: "waiting-fill-deadline", fastAt: null, slowAt: EXPIRES });
  });

  test("row 10: fast unavailable waits for expiry with the reason", () => {
    expect(
      deriveRefundView(order, snap({ fast: { unavailable: "chain-map-missing" } }), FAST_WINDOW)
    ).toEqual({ kind: "waiting-expiry", slowAt: EXPIRES, fastReason: "chain-map-missing" });
  });

  test("row 11: attested inside the buffer is finish-only, not blocked", () => {
    const view = deriveRefundView(
      order,
      snap({ fast: progress(order, { attested: true }) }),
      EXPIRES - 60
    );
    expect(view).toMatchObject({ kind: "fast", step: "refund", finishOnly: true });
    const early = deriveRefundView(
      order,
      snap({ fast: progress(order, { attested: true }) }),
      FAST_WINDOW
    );
    expect(early).toMatchObject({ kind: "fast", step: "refund", finishOnly: false });
  });

  test("row 12: the expiry buffer beats an existing proof source", () => {
    const fast = progress(order, { source: EVM_SOURCE });
    expect(deriveRefundView(order, snap({ fast }), EXPIRES - 7200)).toEqual({
      kind: "waiting-expiry",
      slowAt: EXPIRES,
      fastReason: "expiry-buffer"
    });
    expect(deriveRefundView(order, snap({ fast }), EXPIRES - 7201)).toMatchObject({
      kind: "fast",
      step: "prove"
    });
  });

  test("row 16: nothing recorded yet → record", () => {
    expect(deriveRefundView(order, snap({ fast: progress(order) }), FAST_WINDOW)).toMatchObject({
      kind: "fast",
      step: "record"
    });
  });

  describe("Solana destination (rows 14-15)", () => {
    // Expiry well past the 48h Solana record window, so the 2h buffer stays out of the way.
    const toSolana = makeOrder({
      expires: FILL_DEADLINE + 7 * 24 * 3600,
      outputs: [
        output({
          chainId: SOLANA,
          oracle: SOLANA_POLYMER_ORACLE_PROGRAM,
          settler: SOLANA_OUTPUT_SETTLER_PDA
        })
      ]
    });

    test("consumed and legacy records are unusable", () => {
      for (const kind of ["consumed", "legacy"] as const) {
        const fast = progress(toSolana, { solanaLocal: { kind } });
        expect(deriveRefundView(toSolana, snap({ fast }), FAST_WINDOW)).toMatchObject({
          kind: "waiting-expiry",
          fastReason: `solana-attestation-${kind}`
        });
      }
    });

    test("a fresh record closes 600s before the 48h window ends", () => {
      const fast = progress(toSolana, { solanaLocal: { kind: "absent" } });
      const edge = FILL_DEADLINE + 172_800 - 600;
      expect(deriveRefundView(toSolana, snap({ fast }), edge)).toMatchObject({
        kind: "fast",
        step: "record"
      });
      expect(deriveRefundView(toSolana, snap({ fast }), edge + 1)).toMatchObject({
        kind: "waiting-expiry",
        fastReason: "solana-window-elapsed"
      });
    });

    test("a pending (current) record is resumable past the window", () => {
      const fast = progress(toSolana, { solanaLocal: { kind: "current", rentRefund: "x" } });
      expect(deriveRefundView(toSolana, snap({ fast }), FILL_DEADLINE + 172_800)).toMatchObject({
        kind: "fast",
        step: "record"
      });
    });
  });
});

describe("selectFastRail (plan §5.3)", () => {
  test("EVM→EVM uses the matching Polymer oracle output", () => {
    const rail = railOf(makeOrder());
    expect(rail.outputIndex).toBe(0);
    expect(rail.destKind).toBe("evm");
  });

  test("skips an output whose oracle isn't the input oracle", () => {
    const order = makeOrder({
      outputs: [output({ oracle: `0x${"99".repeat(32)}` }), output({ chainId: 10n })]
    });
    expect(railOf(order).outputIndex).toBe(1);
    const none = makeOrder({ outputs: [output({ oracle: `0x${"99".repeat(32)}` })] });
    expect(selectFastRail(none)).toEqual({ reason: "no-provable-output" });
  });

  test("an output on a chain lintent doesn't know is never the rail", () => {
    expect(selectFastRail(makeOrder({ outputs: [output({ chainId: 130n })] }))).toEqual({
      reason: "no-provable-output"
    });
  });

  test("EVM→Solana requires the Polymer program and output settler PDA", () => {
    const good = output({
      chainId: SOLANA,
      oracle: SOLANA_POLYMER_ORACLE_PROGRAM,
      settler: SOLANA_OUTPUT_SETTLER_PDA
    });
    expect(railOf(makeOrder({ outputs: [good] })).destKind).toBe("solana");
    const pdaOracle = { ...good, oracle: SOLANA_POLYMER_ORACLE_PDA };
    expect(selectFastRail(makeOrder({ outputs: [pdaOracle] }))).toEqual({
      reason: "no-provable-output"
    });
  });

  test("Solana→EVM uses the destination chain's padded oracle", () => {
    const order = makeOrder({ originChainId: SOLANA, inputOracle: SOLANA_POLYMER_ORACLE_PDA });
    expect(railOf(order).destKind).toBe("evm");
  });

  test("ineligible routes", () => {
    const fromSolana = { originChainId: SOLANA, inputOracle: SOLANA_POLYMER_ORACLE_PDA };
    // Every output on the origin chain is caught as same-chain first.
    expect(
      selectFastRail(makeOrder({ ...fromSolana, outputs: [output({ chainId: SOLANA })] }))
    ).toEqual({ reason: "same-chain" });
    expect(
      selectFastRail(makeOrder({ ...fromSolana, outputs: [output({ chainId: SOLANA }), output()] }))
    ).toEqual({ reason: "solana-to-solana" });
    expect(
      selectFastRail(makeOrder({ inputOracle: COIN_FILLER, outputs: [output({ chainId: BASE })] }))
    ).toEqual({ reason: "same-chain" });
    expect(selectFastRail(makeOrder({}, { legacySettler: true }))).toEqual({
      reason: "legacy-settler"
    });
    expect(selectFastRail(makeOrder({ inputOracle: COIN_FILLER }))).toEqual({
      reason: "unsupported-input-oracle"
    });
  });

  test("Tron origin accepts its own Polymer oracle", () => {
    const tronOracle = "0x94b0c01e26aff5a6a0fd767afe0e3ca0f8b34e3d" as const;
    const order = makeOrder({
      originChainId: TRON_MAINNET_CHAIN_ID,
      inputOracle: tronOracle,
      outputs: [output({ oracle: addressToBytes32(tronOracle) })]
    });
    expect(railOf(order).outputIndex).toBe(0);
  });
});

describe("preSpendVerdict (plan §5.5)", () => {
  const order = makeOrder();
  const open: { escrow: EscrowState; outputs: OutputFill[]; attested: boolean } = {
    escrow: "deposited",
    outputs: ["unfilled"],
    attested: false
  };

  // The receive runs after a Polymer poll that can take a minute or more; the
  // re-check must see what changed in between, not the pre-poll eligibility.
  describe("prove: state changed while polling Polymer", () => {
    const beforePoll = EXPIRES - 7200 - 30;

    test("eligible before the poll", () => {
      expect(preSpendVerdict(order, "prove", open, beforePoll)).toBe("go");
    });

    test("the poll ran into the expiry buffer → blocked", () => {
      expect(preSpendVerdict(order, "prove", open, beforePoll + 30)).toEqual({
        blocked: "Too close to expiry to start a fast refund."
      });
    });

    test("a solver filled meanwhile → blocked", () => {
      expect(preSpendVerdict(order, "prove", { ...open, outputs: ["filled"] }, beforePoll)).toEqual(
        { blocked: "An output was filled. Refund isn't possible." }
      );
    });

    test("the escrow was refunded or claimed meanwhile → blocked", () => {
      for (const escrow of ["refunded", "claimed", "closed"] as const) {
        expect(preSpendVerdict(order, "prove", { ...open, escrow }, beforePoll)).toHaveProperty(
          "blocked"
        );
      }
    });

    test("a third party delivered the proof → no-op, even inside the buffer", () => {
      const proven = { ...open, attested: true };
      expect(preSpendVerdict(order, "prove", proven, beforePoll)).toBe("already-proven");
      expect(preSpendVerdict(order, "prove", proven, EXPIRES - 60)).toBe("already-proven");
    });

    test("a fill beats a third-party proof", () => {
      expect(
        preSpendVerdict(
          order,
          "prove",
          { ...open, outputs: ["filled"], attested: true },
          beforePoll
        )
      ).toHaveProperty("blocked");
    });
  });

  test("record waits for the fill deadline", () => {
    expect(preSpendVerdict(order, "record", open, FILL_DEADLINE)).toHaveProperty("blocked");
    expect(preSpendVerdict(order, "record", open, FILL_DEADLINE + 1)).toBe("go");
  });

  test("fast refund needs the proof and stops at expiry, but ignores the buffer", () => {
    const proven = { ...open, attested: true };
    expect(preSpendVerdict(order, "fast", open, FAST_WINDOW)).toHaveProperty("blocked");
    expect(preSpendVerdict(order, "fast", proven, EXPIRES - 60)).toBe("go");
    expect(preSpendVerdict(order, "fast", proven, EXPIRES)).toHaveProperty("blocked");
  });

  test("slow refund needs an open escrow with every output readable and unfilled", () => {
    expect(preSpendVerdict(order, "slow", open, EXPIRES + 1)).toBe("go");
    expect(preSpendVerdict(order, "slow", { ...open, outputs: ["unknown"] }, EXPIRES + 1)).toEqual({
      blocked: "Can't verify every output from this page. Refund isn't possible here."
    });
  });
});

describe("matchesNotFilledLog", () => {
  const expected = output();
  test("exact match", () => {
    expect(matchesNotFilledLog({ output: expected, fillDeadline: 5 }, expected, 5)).toBe(true);
  });
  test("any differing field or deadline rejects", () => {
    expect(matchesNotFilledLog({ output: expected, fillDeadline: 6 }, expected, 5)).toBe(false);
    for (const over of [
      { oracle: `0x${"01".repeat(32)}` },
      { settler: `0x${"01".repeat(32)}` },
      { chainId: 1n },
      { token: `0x${"01".repeat(32)}` },
      { amount: 2n },
      { recipient: `0x${"01".repeat(32)}` },
      { callbackData: "0x01" },
      { context: "0x01" }
    ] as Partial<MandateOutput>[]) {
      expect(
        matchesNotFilledLog({ output: { ...expected, ...over }, fillDeadline: 5 }, expected, 5)
      ).toBe(false);
    }
  });
});
