import assert from "node:assert/strict";
import { mock } from "bun:test";
import {
  addressToBytes32,
  encodeNotFilledDescription,
  SOLANA_MAINNET_CHAIN_ID
} from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import { keccak256 } from "viem";
import type { Hex } from "viem";
import type { EscrowRefundOrder } from "../../src/lib/libraries/refundLookup";
import type {
  WormholeExpectedMessage,
  WormholePublication
} from "../../src/lib/libraries/wormholeProof";
import { WORMHOLE_ORACLE_ABI } from "../../src/lib/abi/wormholeoracle";

mock.module("$app/environment", () => ({ browser: false }));
// Intentional module-loading boundary: production readers must load only after
// registering per-process RPC/clock/history mocks, not via hoisted static imports.
const config = await import("../../src/lib/config");
const scenario = process.argv[2]!;
const now = Math.floor(Date.now() / 1000);
const solana = scenario.startsWith("solana-");
const orderId = `0x${"ab".repeat(32)}` as Hex;
const output: MandateOutput = {
  chainId: solana ? BigInt(SOLANA_MAINNET_CHAIN_ID) : 42161n,
  oracle: solana
    ? config.WORMHOLE_ORACLE[Number(SOLANA_MAINNET_CHAIN_ID)]!
    : addressToBytes32(config.WORMHOLE_ORACLE[42161]!),
  settler: solana ? config.SOLANA_OUTPUT_SETTLER : addressToBytes32(config.COIN_FILLER),
  token: `0x${"11".repeat(32)}`,
  recipient: `0x${"22".repeat(32)}`,
  amount: 1_000_000n,
  callbackData: "0x",
  context: "0x"
};
const standard = {
  user: `0x${"33".repeat(20)}`,
  nonce: 1n,
  originChainId: 8453n,
  inputOracle: config.WORMHOLE_ORACLE[8453]!,
  inputs: [[1n, 1n]],
  outputs: [output],
  fillDeadline: now - (solana ? 173_000 : 100),
  expires: now + 20_000
};
if (scenario === "solana-window-boundary" || scenario === "solana-afterwallet-window") {
  standard.fillDeadline = now - 172_200;
}
if (scenario === "solana-deadline") standard.fillDeadline = now - 100;
const order = {
  orderId,
  order: standard,
  legacySettler: false,
  container: {
    inputSettler: config.INPUT_SETTLER_ESCROW_LIFI,
    order: standard,
    sponsorSignature: {},
    allocatorSignature: {}
  },
  meta: {
    onChainOrderId: orderId,
    orderStatus: "Signed",
    orderInitiatedTxHash: null,
    orderDeliveredTxHash: null,
    orderSettledTxHash: null,
    refundTxHash: null
  }
} as unknown as EscrowRefundOrder;
const expected: WormholeExpectedMessage = {
  application: output.settler,
  payload: encodeNotFilledDescription({ orderId, output, fillDeadline: standard.fillDeadline })
};
const publication: WormholePublication = {
  id: {
    network: "mainnet",
    emitterChain: solana ? 1 : 23,
    emitter: output.oracle,
    sequence: "9007199254740993"
  },
  nonce: 0,
  consistencyLevel: solana ? 32 : 15,
  txRef: `0x${"ff".repeat(32)}`
};
const state = {
  proven: false,
  map: 42161n,
  reverse: 23n,
  destinationUnavailable: false,
  proofs: 0,
  maps: 0,
  finds: 0,
  spends: 0,
  finalized: 0,
  routeReads: 0,
  clock: now
};
if (scenario === "solana-afterwallet-window") Date.now = () => state.clock * 1000;
const clients = new Map<number, object>();
for (const id of [8453, 42161]) {
  clients.set(id, {
    getChainId: async () => {
      state.routeReads++;
      if (id === 42161 && state.destinationUnavailable) throw new Error("Destination offline");
      return id;
    },
    getBytecode: async () => "0x6000",
    readContract: async (args: { functionName: string; args?: unknown[]; abi: unknown }) => {
      switch (args.functionName) {
        case "orderStatus":
          return 1;
        case "isProven": {
          state.proofs++;
          assert.equal(args.abi, WORMHOLE_ORACLE_ABI);
          assert.deepEqual(args.args, [
            output.chainId,
            output.oracle,
            output.settler,
            keccak256(expected.payload)
          ]);
          return state.proven;
        }
        case "WORMHOLE":
          return config.WORMHOLE_CORE[id];
        case "chainId":
          return config.WORMHOLE_CHAIN_IDS[id];
        case "chainIdMap":
          state.maps++;
          return state.map;
        case "reverseChainIdMap":
          state.maps++;
          return state.reverse;
        default:
          throw new Error(`Unexpected read ${args.functionName}`);
      }
    }
  });
}
mock.module("../../src/lib/config", () => ({
  ...config,
  getClient: (id: number | bigint) => clients.get(Number(id))
}));
mock.module("../../src/lib/libraries/fillStatus", () => ({
  isOutputFilled: async (_id: Hex, candidate: MandateOutput) => {
    if (candidate !== output && scenario === "unreadable")
      throw new Error("Second output RPC failed");
    return candidate !== output && scenario === "filled";
  }
}));
mock.module("../../src/lib/libraries/wormholeProof", () => ({
  findWormholePublication: async (candidate: MandateOutput, message: WormholeExpectedMessage) => {
    state.finds++;
    assert.equal(candidate, output);
    assert.deepEqual(message, expected);
    if (scenario === "history-error" || scenario === "third-party" || scenario === "slow") {
      throw new Error(
        "Wormhole publication history unavailable. Retry with an archival RPC or the publication transaction."
      );
    }
    if (scenario === "transport-error")
      throw new Error("Couldn't reach Wormhole Scan. Retry to resume the same message.");
    return scenario === "recovered" ? publication : null;
  }
}));
const solanaClient = await import("../../src/lib/solana/client");
mock.module("../../src/lib/solana/client", () => ({
  ...solanaClient,
  getSolanaReads: async (id: bigint | number) => {
    if (BigInt(id) !== SOLANA_MAINNET_CHAIN_ID)
      throw new Error("No finalized-clock fixture for this cluster");
    return {
      getFinalizedBlockTime: async () => {
        state.finalized++;
        if (scenario === "solana-clock") throw new Error("Finalized clock unavailable");
        if (scenario === "solana-deadline") return standard.fillDeadline;
        if (scenario === "solana-clock-lag") return now - 601;
        return state.clock;
      }
    };
  }
}));
const solanaReadHelpers = await import("../../src/lib/solana/reads");
mock.module("../../src/lib/solana/reads", () => ({
  ...solanaReadHelpers,
  readNotFilledLocalAttestation: async (_reads: unknown, args: { output: MandateOutput }) => {
    assert.equal(args.output.oracle, config.WORMHOLE_ORACLE[Number(SOLANA_MAINNET_CHAIN_ID)]);
    return scenario === "solana-current" || scenario === "solana-clock-lag"
      ? { kind: "current", rentRefund: "stored-recipient" }
      : { kind: "absent" };
  }
}));
// EVM scenarios exercise the real exact-map/deployment checker. These Solana
// scenarios isolate mint-window policy from separately tested account layouts.
const routeHelpers = await import("../../src/lib/libraries/oracleRoute");
mock.module("../../src/lib/libraries/oracleRoute", () => ({
  ...routeHelpers,
  checkWormholeRoute: solana
    ? async () => ({ ready: true as const })
    : routeHelpers.checkWormholeRoute
}));
const { assertStillRefundable, checkFastRailOnChain, readRefundSnapshot } = await import(
  "../../src/lib/libraries/refundReads"
);
const { deriveRefundView, selectFastRail } = await import("../../src/lib/libraries/refundState");
const rail = selectFastRail(order);
assert.ok(!("reason" in rail));
const attempt = async (mode: "record" | "prove" | "fast" | "slow") => {
  if ((await assertStillRefundable(order, mode, rail)) === "go") state.spends++;
};

switch (scenario) {
  case "third-party": {
    state.proven = true;
    state.destinationUnavailable = true;
    const snapshot = await readRefundSnapshot(order, now);
    const view = deriveRefundView(order, snapshot, now);
    assert.ok(view?.kind === "fast" && view.step === "refund");
    await attempt("record");
    await attempt("prove");
    assert.equal(state.spends, 0);
    await attempt("fast");
    assert.equal(state.spends, 1);
    assert.equal(state.routeReads, 0);
    assert.equal(state.finds, 0);
    break;
  }
  case "slow": {
    standard.expires = now - 1;
    state.destinationUnavailable = true;
    const snapshot = await readRefundSnapshot(order, now);
    assert.equal(deriveRefundView(order, snapshot, now)?.kind, "slow");
    await attempt("slow");
    assert.equal(state.spends, 1);
    assert.equal(state.proofs, 0);
    assert.equal(state.routeReads, 0);
    assert.equal(state.finds, 0);
    break;
  }
  case "exact-map": {
    state.map = 999n;
    state.reverse = 1n;
    assert.deepEqual(await checkFastRailOnChain(order, rail), {
      reason: "wormhole-route-unavailable"
    });
    await assert.rejects(attempt("record"));
    await assert.rejects(attempt("prove"));
    assert.equal(state.spends, 0);
    assert.equal(state.finds, 0);
    break;
  }
  case "retry-route": {
    state.map = 999n;
    assert.deepEqual(await checkFastRailOnChain(order, rail), {
      reason: "wormhole-route-unavailable"
    });
    state.map = 42161n;
    assert.equal(await checkFastRailOnChain(order, rail), true);
    const maps = state.maps;
    assert.equal(await checkFastRailOnChain(order, rail), true);
    assert.equal(state.maps, maps);
    state.destinationUnavailable = true;
    assert.deepEqual(await checkFastRailOnChain(order, rail), {
      reason: "wormhole-route-unavailable"
    });
    break;
  }
  case "recovered": {
    const snapshot = await readRefundSnapshot(order, now);
    assert.ok(snapshot.fast && !("unavailable" in snapshot.fast));
    assert.deepEqual(snapshot.fast.source, { kind: "wormhole", publication });
    const view = deriveRefundView(order, snapshot, now);
    assert.ok(view?.kind === "fast" && view.step === "prove");
    break;
  }
  case "history-error":
  case "transport-error": {
    const snapshot = await readRefundSnapshot(order, now);
    assert.deepEqual(snapshot.fast, { unavailable: "wormhole-publication-unavailable" });
    assert.equal(deriveRefundView(order, snapshot, now)?.kind, "waiting-expiry");
    assert.equal(state.spends, 0);
    break;
  }
  case "filled":
  case "unreadable":
  case "missing":
  case "delivered":
  case "settled":
  case "settled-tx": {
    state.proven = true;
    if (scenario === "delivered") order.meta.orderStatus = "Delivered";
    else if (scenario === "settled") order.meta.orderStatus = "Settled";
    else if (scenario === "settled-tx") order.meta.orderSettledTxHash = `0x${"ee".repeat(32)}`;
    else
      standard.outputs.push({
        ...output,
        amount: 2_000_000n,
        ...(scenario === "missing" ? { chainId: 987654321n } : {})
      });
    for (const mode of ["record", "prove", "fast", "slow"] as const)
      await assert.rejects(attempt(mode));
    if (scenario === "settled-tx") {
      assert.equal((await readRefundSnapshot(order, now)).fast, null);
      assert.equal(state.routeReads, 0);
    }
    assert.equal(state.spends, 0);
    assert.equal(state.finds, 0);
    break;
  }
  case "solana-window": {
    const snapshot = await readRefundSnapshot(order, now);
    assert.deepEqual(snapshot.fast, { unavailable: "solana-window-elapsed" });
    assert.equal(deriveRefundView(order, snapshot, now)?.kind, "waiting-expiry");
    assert.equal(state.finalized, 1);
    break;
  }
  case "solana-window-boundary":
  case "solana-current": {
    const snapshot = await readRefundSnapshot(order, now);
    const view = deriveRefundView(order, snapshot, now);
    assert.ok(view?.kind === "fast" && view.step === "record");
    assert.equal(state.finalized, 1);
    break;
  }
  case "solana-clock":
  case "solana-deadline":
  case "solana-clock-lag": {
    await assert.rejects(readRefundSnapshot(order, now), /Couldn't read/);
    assert.equal(state.spends, 0);
    break;
  }
  case "solana-afterwallet-window": {
    assert.equal(await assertStillRefundable(order, "record", rail), "go");
    // Wallet preparation elapsed one second past the exact 600-second margin.
    state.clock++;
    await assert.rejects(attempt("record"), /48h/);
    assert.equal(state.spends, 0);
    // Proof registration consumes no local record and has no mint deadline.
    await attempt("prove");
    assert.equal(state.spends, 1);
    assert.equal(state.finalized, 2);
    break;
  }
  default:
    throw new Error(`Unknown scenario ${scenario}`);
}
