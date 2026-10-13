import assert from "node:assert/strict";
import { mock } from "bun:test";
import { compileModule } from "svelte/compiler";
import { addressToBytes32, encodeNotFilledDescription } from "@lifi/intent";
import type { StandardOrder } from "@lifi/intent";
import type { EscrowRefundOrder } from "../../src/lib/libraries/refundLookup";
import type { RefundSnapshot } from "../../src/lib/libraries/refundState";
import type { WormholePublication } from "../../src/lib/libraries/wormholeProof";
import type { Hex } from "viem";
import { keccak256 } from "viem";
import { b32, makeMandateOutput, TEST_NOW_SECONDS } from "./orderFixtures";
import * as config from "../../src/lib/config";

const scenario = process.argv[2]!;
mock.module("$app/environment", () => ({ browser: false }));
const output = makeMandateOutput(42161n, 123n, {
  oracle: addressToBytes32(config.WORMHOLE_ORACLE[42161]!),
  settler: addressToBytes32(config.COIN_FILLER)
});
const signed = {
  user: `0x${"cd".repeat(20)}`,
  nonce: 1n,
  originChainId: 8453n,
  expires: TEST_NOW_SECONDS + 10800,
  fillDeadline: TEST_NOW_SECONDS,
  inputOracle: config.WORMHOLE_ORACLE[8453]!,
  inputs: [[1n, 1000n]],
  outputs: [output]
} as StandardOrder;
const order = {
  orderId: b32("a"),
  order: signed,
  container: {
    order: signed,
    inputSettler: `0x${"ab".repeat(20)}`,
    sponsorSignature: {},
    allocatorSignature: {}
  },
  legacySettler: false,
  meta: {
    onChainOrderId: b32("a"),
    orderStatus: "Signed",
    orderInitiatedTxHash: null,
    orderDeliveredTxHash: null,
    orderSettledTxHash: null,
    refundTxHash: null
  }
} as EscrowRefundOrder;
const publication: WormholePublication = {
  id: {
    network: "mainnet",
    emitterChain: 23,
    emitter: output.oracle,
    sequence: "9007199254740993"
  },
  nonce: 0,
  consistencyLevel: 15,
  txRef: b32("f")
};
const source = { kind: "wormhole" as const, publication };
const snapshot: RefundSnapshot = {
  escrow: "deposited",
  outputs: ["unfilled"],
  fast: {
    rail: {
      provider: "wormhole",
      outputIndex: 0,
      output,
      destKind: "evm",
      notFilledHash: keccak256(
        encodeNotFilledDescription({
          orderId: order.orderId,
          output,
          fillDeadline: signed.fillDeadline
        })
      )
    },
    source,
    attested: false
  }
};
const state = {
  reads: [] as (() => Promise<RefundSnapshot>)[],
  calls: [] as string[],
  pollMode: "pending",
  hints: [] as { application: Hex; payload: Hex }[],
  crumbs: [] as Hex[],
  sources: [] as unknown[]
};
mock.module("../../src/lib/libraries/refundLookup", () => ({
  REFUND_CHAIN_IDS: [8453, 42161],
  isEscrowRefundOrder: (value: EscrowRefundOrder) => !!value.order && !value.unsupported,
  lookupRefundOrder: async () => order
}));
mock.module("../../src/lib/libraries/refundReads", () => ({
  readRefundSnapshot: async () => (state.reads.shift() ?? (async () => snapshot))()
}));
mock.module("../../src/lib/libraries/refundActions", () => ({
  describeActionError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  submitSlowRefund: async () => {
    state.calls.push("slow");
  },
  submitFastRefund: async () => {
    state.calls.push("fast");
  },
  submitNonFillRecord: async () => {
    state.calls.push("record");
  },
  fetchNonFillProof: async (
    _order: unknown,
    _rail: unknown,
    verified: unknown,
    onProgress: (attempt: number, total: number) => void
  ) => {
    state.sources.push(verified);
    onProgress(0, 6);
    if (state.pollMode === "transport")
      throw new Error("Couldn't reach Wormhole Scan. Retry to resume the same message.");
    return state.pollMode === "pending"
      ? { status: "pending" }
      : { status: "proof", proof: "0x1234" };
  },
  submitNonFillProof: async (
    _order: unknown,
    _rail: unknown,
    _proof: unknown,
    verified: unknown,
    onProgress: (stage: string) => void
  ) => {
    state.sources.push(verified);
    onProgress("Verify guardian signatures");
    onProgress("Post VAA");
    throw new Error("Post VAA rejected");
  }
}));
mock.module("../../src/lib/libraries/refundBreadcrumbs", () => ({
  clearBreadcrumb: (id: Hex) => state.crumbs.push(id)
}));
mock.module("../../src/lib/libraries/wormholeProof", () => ({
  clearWormholeHint: (_output: unknown, expected: { application: Hex; payload: Hex }) =>
    state.hints.push(expected)
}));
mock.module("../../src/lib/libraries/oracleRoute", () => ({ oracleProviderFor: () => "wormhole" }));
// Execute the real rune controller, not a rewritten lookalike. Bun normally
// transpiles TypeScript only; this loader supplies Svelte's module transform.
const transpiler = new Bun.Transpiler({ loader: "ts" });
Bun.plugin({
  name: "refund-flow-runes",
  setup(builder) {
    builder.onLoad({ filter: /refundFlow\.svelte\.ts$/ }, async ({ path }) => ({
      contents: compileModule(transpiler.transformSync(await Bun.file(path).text()), {
        filename: path,
        generate: "client"
      }).js.code,
      loader: "js"
    }));
  }
});
// Intentionally exercise loading after environment/mocks and rune transform.
const { RefundFlow } = await import("../../src/lib/libraries/refundFlow.svelte");
const flow = new RefundFlow();
flow.order = order;
flow.snapshot = snapshot;
flow.now = TEST_NOW_SECONDS + 1;

switch (scenario) {
  case "flow-read-failure": {
    const warn = console.warn;
    console.warn = () => {};
    state.reads.push(async () => {
      throw new Error("RPC unavailable");
    });
    await flow.refresh();
    console.warn = warn;
    assert.equal(flow.snapshot, snapshot);
    assert.equal(flow.readError, "RPC unavailable");
    await flow.runRecord();
    await flow.runProve();
    await flow.runFastRefund();
    await flow.runSlowRefund();
    assert.deepEqual(state.calls, []);
    assert.deepEqual(state.sources, []);
    await flow.refresh();
    assert.equal(flow.readError, null);
    await flow.runRecord();
    assert.deepEqual(state.calls, ["record"]);
    break;
  }
  case "flow-stale-refresh": {
    const old = Promise.withResolvers<RefundSnapshot>();
    state.reads.push(() => old.promise);
    const first = flow.refresh();
    const replacement = { ...snapshot, outputs: ["filled" as const] };
    state.reads.push(async () => replacement);
    await flow.refresh();
    old.resolve(snapshot);
    await first;
    assert.equal(flow.snapshot, replacement);
    assert.equal(flow.refreshing, false);
    break;
  }
  case "flow-pending-resume":
    await flow.runProve();
    assert.equal(flow.proofStatus, "not-ready");
    assert.equal(flow.proofStage, "Waiting for Wormhole guardians");
    state.pollMode = "transport";
    await flow.runProve();
    assert.match(flow.actionError!, /Couldn't reach Wormhole Scan/);
    assert.equal(flow.snapshot, snapshot);
    assert.ok(state.sources.every((value) => value === source));
    state.pollMode = "proof";
    await flow.runProve();
    assert.equal(flow.proofStage, "Post VAA");
    assert.equal(flow.actionError, "Post VAA rejected");
    assert.equal(flow.lastTx.prove, undefined);
    assert.ok(state.sources.every((value) => value === source));
    break;
  case "flow-terminal-hints":
    state.reads.push(async () => ({ escrow: "refunded", outputs: [], fast: null }));
    await flow.refresh();
    assert.deepEqual(state.crumbs, [order.orderId]);
    assert.deepEqual(state.hints, [
      {
        application: output.settler,
        payload: encodeNotFilledDescription({
          orderId: order.orderId,
          output,
          fillDeadline: signed.fillDeadline
        })
      }
    ]);
    break;
  default:
    throw new Error(`Unknown refund flow scenario: ${scenario}`);
}
