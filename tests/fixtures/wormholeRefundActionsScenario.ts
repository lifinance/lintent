import assert from "node:assert/strict";
import { mock } from "bun:test";
import {
  addressToBytes32,
  encodeNotFilledDescription,
  SOLANA_MAINNET_CHAIN_ID
} from "@lifi/intent";
import type { EVMOrder, MandateOutput, StandardOrder } from "@lifi/intent";
import { createVAA, serialize, UniversalAddress } from "@wormhole-foundation/sdk-definitions";
import { bytesToHex, hexToBytes, keccak256 } from "viem";
import type { Hex } from "viem";
import * as config from "../../src/lib/config";
import * as proofHelpers from "../../src/lib/libraries/wormholeProof";
import type {
  WormholeExpectedMessage,
  WormholePublication
} from "../../src/lib/libraries/wormholeProof";
import type { EscrowRefundOrder } from "../../src/lib/libraries/refundLookup";
import type {
  FastRail,
  OutputFill,
  ProofSource,
  SpendMode
} from "../../src/lib/libraries/refundState";
import type {
  SolanaDeps,
  SolanaInstructionLike,
  SolanaSignerLike
} from "../../src/lib/solana/types";
import type {
  PublishSolanaWormholeArgs,
  ReceiveWormholeVaaArgs
} from "../../src/lib/solana/wormhole";
import { b32, makeMandateOutput, TEST_NOW_SECONDS } from "./orderFixtures";

// Process isolation is essential: these orchestration replacements must not
// replace the real SDK/Core subjects in any other unit suite.
mock.module("$app/environment", () => ({ browser: false }));
// Intentionally load the production policy after registering its environment.
const { preSpendVerdict } = await import("../../src/lib/libraries/refundState");
const scenario = process.argv[2]!;
const solanaInput = scenario.startsWith("solana-stage-") || scenario === "solana-final-fill";
const solanaOutput = scenario === "solana-publish";
const polymer = scenario === "polymer";
const ACCOUNT = `0x${"ab".repeat(20)}` as Hex;
const USER = `0x${"cd".repeat(20)}` as Hex;
const TX = b32("f");
const ORDER_ID = b32("a");
const DEADLINE = TEST_NOW_SECONDS;
const EXPIRES = DEADLINE + 10800;
let now = DEADLINE + 1;
Date.now = () => now * 1000;
const output = makeMandateOutput(solanaOutput ? BigInt(SOLANA_MAINNET_CHAIN_ID) : 42161n, 123n, {
  oracle: polymer
    ? addressToBytes32(config.POLYMER_ORACLE[42161]!)
    : solanaOutput
      ? config.WORMHOLE_ORACLE[Number(SOLANA_MAINNET_CHAIN_ID)]!
      : addressToBytes32(config.WORMHOLE_ORACLE[42161]!),
  settler: solanaOutput ? config.SOLANA_OUTPUT_SETTLER : addressToBytes32(config.COIN_FILLER)
});
const signed = {
  user: USER,
  nonce: 1n,
  originChainId: solanaInput ? BigInt(SOLANA_MAINNET_CHAIN_ID) : 8453n,
  expires: EXPIRES,
  fillDeadline: DEADLINE,
  inputOracle: polymer
    ? config.POLYMER_ORACLE[8453]!
    : solanaInput
      ? config.WORMHOLE_ORACLE[Number(SOLANA_MAINNET_CHAIN_ID)]!
      : config.WORMHOLE_ORACLE[8453]!,
  inputs: [[1n, 1000n]],
  outputs: [output, { ...output, amount: output.amount + 1n }]
} as StandardOrder;
const order = {
  orderId: ORDER_ID,
  order: signed,
  container: { inputSettler: ACCOUNT, order: signed, sponsorSignature: {}, allocatorSignature: {} },
  legacySettler: false,
  meta: {
    onChainOrderId: ORDER_ID,
    orderStatus: "Signed",
    orderInitiatedTxHash: null,
    orderDeliveredTxHash: null,
    orderSettledTxHash: null,
    refundTxHash: null
  }
} as EscrowRefundOrder;
const payload = encodeNotFilledDescription({ orderId: ORDER_ID, output, fillDeadline: DEADLINE });
const expected: WormholeExpectedMessage = { application: output.settler, payload };
const rail: FastRail = {
  provider: polymer ? "polymer" : "wormhole",
  outputIndex: 0,
  output,
  destKind: solanaOutput ? "solana" : "evm",
  notFilledHash: keccak256(payload)
};
const publication: WormholePublication = {
  id: {
    network: "mainnet",
    emitterChain: solanaOutput ? 1 : 23,
    emitter: output.oracle,
    sequence: "9007199254740993"
  },
  nonce: 0,
  consistencyLevel: solanaOutput ? 32 : 15,
  txRef: TX
};
const source: ProofSource = { kind: "wormhole", publication };
function vaa(changed = payload): Hex {
  const part = hexToBytes(changed);
  const envelope = new Uint8Array(36 + part.length);
  envelope.set(hexToBytes(output.settler));
  const view = new DataView(envelope.buffer);
  view.setUint16(32, 1);
  view.setUint16(34, part.length);
  envelope.set(part, 36);
  return bytesToHex(
    serialize(
      createVAA("Uint8Array", {
        guardianSet: 0,
        signatures: [],
        timestamp: DEADLINE,
        nonce: publication.nonce,
        emitterChain: solanaOutput ? "Solana" : "Arbitrum",
        emitterAddress: new UniversalAddress(hexToBytes(output.oracle)),
        sequence: BigInt(publication.id.sequence),
        consistencyLevel: publication.consistencyLevel,
        payload: envelope
      })
    )
  );
}
const state = {
  outputs: ["unfilled", "unfilled"] as OutputFill[],
  attested: false,
  ready: true,
  found: null as WormholePublication | null,
  verified: true,
  publishes: 0,
  sends: [] as string[],
  polls: [] as WormholePublication[],
  preparations: 0,
  receiveProves: true,
  stages: [] as string[],
  pollMode: "proof",
  guardModes: [] as SpendMode[],
  walletChain: Number(signed.originChainId),
  mutatePrepare: false,
  mutateSimulation: false,
  simulationError: null as unknown
};
class RefundActionError extends Error {}
mock.module("../../src/lib/libraries/refundReads", () => ({
  RefundActionError,
  readAttested: async () => state.attested,
  assertStillRefundable: async (current: EscrowRefundOrder, mode: SpendMode) => {
    state.guardModes.push(mode);
    const verdict = preSpendVerdict(
      current,
      mode,
      {
        escrow: "deposited",
        outputs: state.outputs,
        attested: state.attested
      },
      now
    );
    if (typeof verdict === "object") throw new RefundActionError(verdict.blocked);
    if (verdict === "go" && mode !== "slow" && mode !== "fast" && !state.ready) {
      throw new RefundActionError("Wormhole route unavailable");
    }
    return verdict;
  }
}));
const prepare = () => {
  state.preparations++;
  if (state.mutatePrepare) state.outputs[1] = "filled";
  if (scenario === "third-party-wallet") state.attested = true;
};
mock.module("../../src/lib/state.svelte", () => ({
  default: {
    setWalletToCorrectChain: async (chainId: number) => {
      state.walletChain = chainId;
      prepare();
    },
    connectedAccount: { address: ACCOUNT },
    walletClient: {
      getChainId: async () => state.walletChain,
      writeContract: async (call: { functionName: string; args: unknown[] }) => {
        state.sends.push(call.functionName);
        if (call.functionName === "refund" || call.functionName === "refundOnNonFill") {
          assert.equal((call.args[0] as EVMOrder).user, USER);
          assert.notEqual((call.args[0] as EVMOrder).user, ACCOUNT);
        }
        if (call.functionName === "receiveMessage" && state.receiveProves) state.attested = true;
        return TX;
      }
    }
  }
}));
mock.module("../../src/lib/config", () => ({
  ...config,
  getChain: (chainId: number | bigint) => ({ id: Number(chainId) }),
  getClient: () => ({
    simulateContract: async () => {
      if (state.mutateSimulation) state.outputs[1] = "filled";
      if (state.simulationError) throw state.simulationError;
    },
    waitForTransactionReceipt: async () => ({ status: "success" })
  })
}));
mock.module("../../src/lib/libraries/oracleRoute", () => ({
  oracleProviderFor: () => (polymer ? "polymer" : "wormhole")
}));
const signer: SolanaSignerLike = {
  publicKey: "11111111111111111111111111111111",
  signAndSend: async (instructions, opts) => {
    prepare();
    await opts?.beforeSign?.();
    state.sends.push(instructions[0]!.programId);
    return "solana-refund-signature";
  }
};
const deps = { chainId: signed.originChainId, signer } as SolanaDeps;
mock.module("../../src/lib/libraries/solver", () => ({
  solanaDeps: async () => deps,
  tronDeps: async () => {
    throw new Error("unexpected Tron");
  }
}));
const refundInstruction: SolanaInstructionLike = {
  programId: "refund",
  keys: [],
  data: new Uint8Array()
};
mock.module("../../src/lib/solana/writes", () => ({
  refund: async (d: SolanaDeps) => d.signer.signAndSend([refundInstruction]),
  refundOnNonFill: async (d: SolanaDeps) => d.signer.signAndSend([refundInstruction]),
  receiveProof: async () => {
    throw new Error("Wormhole must not use Polymer scratch accounts");
  },
  recordNotFilled: async () => {
    throw new Error("Wormhole must not use Polymer submit_consume");
  }
}));
mock.module("../../src/lib/solana/wormhole", () => ({
  publishSolanaWormhole: async (_d: SolanaDeps, args: PublishSolanaWormholeArgs) => {
    assert.equal(args.kind, "non-fill");
    assert.equal(args.timestamp, DEADLINE);
    assert.equal(args.output.oracle, config.WORMHOLE_ORACLE[Number(SOLANA_MAINNET_CHAIN_ID)]);
    assert.equal(args.payload, payload);
    await args.beforeSpend?.();
    state.publishes++;
    state.found = publication;
    return publication;
  },
  receiveWormholeVaa: async (_d: SolanaDeps, args: ReceiveWormholeVaaArgs) => {
    for (const stage of ["Verify guardian signatures", "Post VAA", "Register proof"]) {
      args.onProgress?.(stage);
      await args.beforeSpend?.();
      if (scenario === "solana-stage-failure" && stage === "Post VAA")
        throw new Error("Post VAA failed");
      state.sends.push(stage);
      if (stage === "Verify guardian signatures") {
        if (scenario === "solana-stage-fill") state.outputs[1] = "filled";
        if (scenario === "solana-stage-proof") state.attested = true;
      }
    }
    state.attested = true;
    return { attestSignature: "solana-receive-signature", attestation: "proof" };
  }
}));
mock.module("../../src/lib/libraries/wormholeProof", () => ({
  ...proofHelpers,
  findWormholePublication: async (_output: MandateOutput, message: WormholeExpectedMessage) => {
    assert.deepEqual(message, expected);
    return state.found;
  },
  verifyWormholePublication: async (
    _output: MandateOutput,
    message: WormholeExpectedMessage,
    pub: WormholePublication
  ) => {
    assert.deepEqual(message, expected);
    assert.equal(pub, publication);
    return state.verified ? publication : null;
  },
  saveWormholeHint: () => {},
  publishEvmWormhole: async (
    _output: MandateOutput,
    tagged: Hex,
    _wallet: unknown,
    account: Hex,
    opts: { beforeSpend: () => Promise<void> }
  ) => {
    assert.equal(tagged, payload);
    assert.equal(account, ACCOUNT);
    await opts.beforeSpend();
    state.publishes++;
    state.found = publication;
    return publication;
  },
  pollWormholeVaa: async (pub: WormholePublication, message: WormholeExpectedMessage) => {
    assert.deepEqual(message, expected);
    state.polls.push(pub);
    if (scenario === "expiry-buffer") now = EXPIRES - 7200;
    if (state.pollMode === "transport")
      throw new Error("Couldn't reach Wormhole Scan. Retry to resume the same message.");
    return state.pollMode === "pending" ? { status: "pending" } : { status: "proof", proof: vaa() };
  }
}));
// This intentionally tests the module-loading boundary: mocks must exist before
// the action module binds browser state and platform dependencies.
const actions = await import("../../src/lib/libraries/refundActions");
const receive = (proof = vaa()) =>
  actions.submitNonFillProof(order, rail, proof, source, (stage) => state.stages.push(stage));
const assertNoSpend = () => {
  assert.equal(state.publishes, 0);
  assert.deepEqual(state.sends, []);
};

if (scenario.startsWith("veto-")) {
  const veto = scenario.slice(5);
  state.attested = true;
  if (veto === "filled" || veto === "unknown") state.outputs[1] = veto;
  else if (veto === "missing") state.outputs.pop();
  else if (veto === "delivery-tx") order.meta.orderDeliveredTxHash = TX;
  else if (veto === "settlement-tx") order.meta.orderSettledTxHash = TX;
  else order.meta.orderStatus = veto;
  for (const action of [
    () => actions.submitNonFillRecord(order, rail),
    receive,
    () => actions.submitFastRefund(order, rail),
    () => actions.submitSlowRefund(order)
  ]) {
    await assert.rejects(action());
  }
  assertNoSpend();
  assert.equal(state.preparations, 0);
} else
  switch (scenario) {
    case "publish-reuse":
      assert.equal(await actions.submitNonFillRecord(order, rail), TX);
      assert.equal(await actions.submitNonFillRecord(order, rail), TX);
      assert.equal(state.publishes, 1);
      assert.equal(state.preparations, 1);
      break;
    case "pending-transport-resume": {
      await actions.submitNonFillRecord(order, rail);
      state.pollMode = "pending";
      assert.deepEqual(await actions.fetchNonFillProof(order, rail, source), { status: "pending" });
      state.pollMode = "transport";
      await assert.rejects(
        actions.fetchNonFillProof(order, rail, source),
        /Couldn't reach Wormhole Scan/
      );
      state.pollMode = "proof";
      const result = await actions.fetchNonFillProof(order, rail, source);
      assert.equal(result.status, "proof");
      await receive();
      assert.equal(state.publishes, 1);
      assert.ok(state.polls.every((pub) => pub === publication));
      break;
    }
    case "source-unverified":
      state.verified = false;
      await assert.rejects(
        actions.fetchNonFillProof(order, rail, source),
        /publication history unavailable/
      );
      await assert.rejects(receive(), /publication history unavailable/);
      assertNoSpend();
      assert.equal(state.preparations, 0);
      assert.equal(state.polls.length, 0);
      break;
    case "fabricated-deadline":
      await assert.rejects(
        receive(
          vaa(encodeNotFilledDescription({ orderId: ORDER_ID, output, fillDeadline: DEADLINE - 1 }))
        ),
        /exact expected/
      );
      assertNoSpend();
      assert.equal(state.preparations, 0);
      break;
    case "third-party":
      state.attested = true;
      assert.equal(await actions.submitNonFillRecord(order, rail), null);
      assert.deepEqual(await actions.fetchNonFillProof(order, rail, source), {
        status: "attested"
      });
      assert.equal(await receive(), null);
      assertNoSpend();
      assert.equal(state.preparations, 0);
      break;
    case "third-party-wallet":
      assert.equal(await receive(), null);
      assertNoSpend();
      assert.equal(state.preparations, 1);
      break;
    case "record-wallet-fill":
      state.mutatePrepare = true;
      await assert.rejects(actions.submitNonFillRecord(order, rail), /output was filled/);
      assertNoSpend();
      break;
    case "receive-wallet-fill":
    case "receive-simulation-fill":
      state.mutatePrepare = scenario === "receive-wallet-fill";
      state.mutateSimulation = scenario === "receive-simulation-fill";
      await assert.rejects(receive(), /output was filled/);
      assertNoSpend();
      break;
    case "fast-wallet-fill":
    case "solana-final-fill":
      state.attested = true;
      state.mutatePrepare = true;
      await assert.rejects(actions.submitFastRefund(order, rail), /output was filled/);
      assertNoSpend();
      break;
    case "slow-wallet-fill":
      now = EXPIRES + 1;
      state.mutatePrepare = true;
      await assert.rejects(actions.submitSlowRefund(order), /output was filled/);
      assertNoSpend();
      break;
    case "expiry-buffer":
      await actions.fetchNonFillProof(order, rail, source);
      await assert.rejects(receive(), /Too close to expiry/);
      assertNoSpend();
      break;
    case "expiry-finish":
      now = EXPIRES - 1;
      state.attested = true;
      assert.equal(await actions.submitFastRefund(order, rail), TX);
      assert.deepEqual(state.sends, ["refundOnNonFill"]);
      assert.equal(state.guardModes.length, 2);
      break;
    case "receipt-without-proof":
      state.receiveProves = false;
      await assert.rejects(receive(), /proof is not registered/);
      assert.deepEqual(state.sends, ["receiveMessage"]);
      break;
    case "solana-stage-fill":
      await assert.rejects(receive(), /output was filled/);
      assert.deepEqual(state.sends, ["Verify guardian signatures"]);
      break;
    case "solana-stage-proof":
      assert.equal(await receive(), null);
      assert.deepEqual(state.sends, ["Verify guardian signatures"]);
      break;
    case "solana-stage-failure":
      await assert.rejects(receive(), /Post VAA failed/);
      assert.equal(state.attested, false);
      assert.deepEqual(state.sends, ["Verify guardian signatures"]);
      break;
    case "solana-publish":
      await actions.submitNonFillRecord(order, rail);
      await actions.submitNonFillRecord(order, rail);
      assert.equal(state.publishes, 1);
      break;
    case "slow-unavailable":
      now = EXPIRES + 1;
      state.ready = false;
      assert.equal(await actions.submitSlowRefund(order), TX);
      assert.deepEqual(state.sends, ["refund"]);
      assert.equal(state.polls.length, 0);
      assert.equal(state.publishes, 0);
      break;
    case "polymer":
      await actions.submitNonFillRecord(order, rail);
      await actions.submitNonFillProof(order, rail, "0x1234");
      assert.deepEqual(state.sends, ["emitNotFilled", "receiveMessage"]);
      assert.deepEqual(state.guardModes, ["record", "prove"]);
      break;
    case "decoded-error":
      state.simulationError = { cause: { data: { errorName: "NotAllPayloadsValid" } } };
      await assert.rejects(receive(), /not attested every payload/);
      assertNoSpend();
      state.simulationError = { cause: { data: { errorName: "VMSignatureInvalid" } } };
      await assert.rejects(receive(), /guardian signature/);
      assertNoSpend();
      break;
    default:
      throw new Error(`Unknown refund scenario: ${scenario}`);
  }
