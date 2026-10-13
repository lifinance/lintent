import assert from "node:assert/strict";
import { mock } from "bun:test";
import { addressToBytes32, encodeFillDescription, SOLANA_MAINNET_CHAIN_ID } from "@lifi/intent";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import { createVAA, serialize, UniversalAddress } from "@wormhole-foundation/sdk-definitions";
import { bytesToHex, hexToBytes, keccak256 } from "viem";
import type { Hex } from "viem";
import * as config from "../../src/lib/config";
import type { WC } from "../../src/lib/config";
import * as proofHelpers from "../../src/lib/libraries/wormholeProof";
import type {
  WormholeExpectedMessage,
  WormholePublication
} from "../../src/lib/libraries/wormholeProof";
import type { WormholeFillOptions } from "../../src/lib/libraries/wormholeFill";
import type { SolanaDeps } from "../../src/lib/solana/types";
import { b32, makeMandateOutput, TEST_NOW_SECONDS } from "./orderFixtures";

// Each scenario runs in a separate Bun process. Module replacements cannot
// corrupt the real publication/Core tests in the surrounding unit-test run.
const scenario = process.argv[2];
const EVM_ACCOUNT = `0x${"ab".repeat(20)}` as Hex;
const INPUT_ACCOUNT = `0x${"cd".repeat(20)}` as Hex;
const ORDER_ID = b32("a");
const SOLVER = b32("b");
const TX = b32("f");
const solanaOutput = scenario === "solana-publication-singleflight";
const solanaInput = scenario === "two-wallets" || scenario === "solana-stage-failure";
const output: MandateOutput = makeMandateOutput(
  solanaOutput ? BigInt(SOLANA_MAINNET_CHAIN_ID) : 42161n,
  123n,
  {
    oracle: solanaOutput
      ? config.WORMHOLE_ORACLE[Number(SOLANA_MAINNET_CHAIN_ID)]!
      : addressToBytes32(config.WORMHOLE_ORACLE[42161]!),
    settler: solanaOutput ? config.SOLANA_OUTPUT_SETTLER : addressToBytes32(config.COIN_FILLER)
  }
);
const sourceChainId = solanaInput ? BigInt(SOLANA_MAINNET_CHAIN_ID) : 8453n;
const inputOracle = solanaInput
  ? config.WORMHOLE_ORACLE[Number(SOLANA_MAINNET_CHAIN_ID)]!
  : config.WORMHOLE_ORACLE[8453]!;
const orderContainer = { order: { inputOracle, outputs: [output] } } as OrderContainer;
const payload = encodeFillDescription({
  orderId: ORDER_ID,
  output,
  solver: SOLVER,
  timestamp: TEST_NOW_SECONDS
});
const expected: WormholeExpectedMessage = { application: output.settler, payload };
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
function vaa(changedPayload = payload): Hex {
  const part = hexToBytes(changedPayload);
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
        timestamp: TEST_NOW_SECONDS,
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
  proven: new Set<string>(),
  publication: undefined as WormholePublication | undefined,
  publishes: 0,
  evmReceives: 0,
  solanaReceives: 0,
  posts: 0,
  finds: 0,
  polls: 0,
  preparations: [] as number[],
  stages: [] as string[],
  walletChain: 42161,
  outputAccounts: [] as Hex[],
  deliveryAccounts: [] as Hex[],
  ready: true,
  pollMode: "proof",
  rejectReceive: false,
  receiveProves: true
};
const readProof = (chainId: bigint) => state.proven.has(chainId.toString());
const clientFor = (chainId: number | bigint) => ({
  getChainId: async () => Number(chainId),
  readContract: async (args: { functionName: string; args: unknown[] }) => {
    assert.equal(args.functionName, "isProven");
    assert.deepEqual(args.args, [
      output.chainId,
      output.oracle,
      output.settler,
      keccak256(payload)
    ]);
    return readProof(BigInt(chainId));
  },
  simulateContract: async (args: { account: Hex; functionName: string; args: Hex[] }) => {
    assert.equal(args.functionName, "receiveMessage");
    assert.equal(args.args[0], vaa());
    state.deliveryAccounts.push(args.account);
    return { request: args };
  },
  waitForTransactionReceipt: async () => ({ status: "success" })
});
const wallet = {
  getChainId: async () => state.walletChain,
  getAddresses: async () => [EVM_ACCOUNT, INPUT_ACCOUNT],
  writeContract: async (request: { chain: { id: number }; account: Hex }) => {
    state.evmReceives++;
    assert.equal(state.walletChain, request.chain.id);
    assert.equal(request.account, INPUT_ACCOUNT);
    if (state.rejectReceive) throw new Error("Wallet rejected registration");
    if (state.receiveProves) state.proven.add(String(request.chain.id));
    return TX;
  }
} as unknown as WC;
mock.module("../../src/lib/config", () => ({
  ...config,
  getClient: clientFor,
  getChain: (chainId: number | bigint) => ({ id: Number(chainId) })
}));
mock.module("../../src/lib/utils/walletClientRuntime", () => ({
  switchWalletChain: async (_wallet: unknown, chainId: number) => {
    state.walletChain = chainId;
  }
}));
mock.module("../../src/lib/libraries/oracleRoute", () => ({
  assertWormholeOrderReady: async () => {
    if (!state.ready) throw new Error("Wormhole route unavailable");
  }
}));
mock.module("../../src/lib/libraries/fillEvent", () => ({
  getFillDetails: async () => ({ solver: SOLVER, timestamp: TEST_NOW_SECONDS })
}));
mock.module("../../src/lib/solana/client", () => ({
  getSolanaReads: async (chainId: bigint) => ({ chainId })
}));
mock.module("../../src/lib/solana/reads", () => ({
  readIsProvenOnSolana: async (
    reads: { chainId: bigint },
    args: { inputOracle: Hex; output: MandateOutput; payloadHash: Hex }
  ) => {
    assert.equal(args.inputOracle, inputOracle);
    assert.deepEqual(args.output, output);
    assert.equal(args.payloadHash, keccak256(payload));
    return readProof(reads.chainId);
  }
}));
mock.module("../../src/lib/solana/wormhole", () => ({
  publishSolanaWormhole: async (
    _deps: SolanaDeps,
    args: { solverBytes32: Hex; timestamp: number; payload: Hex; beforeSpend: () => Promise<void> }
  ) => {
    await args.beforeSpend();
    assert.equal(args.solverBytes32, SOLVER);
    assert.equal(args.timestamp, TEST_NOW_SECONDS);
    assert.equal(args.payload, payload);
    state.publishes++;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
    state.publication = publication;
    return publication;
  },
  receiveWormholeVaa: async (
    _deps: SolanaDeps,
    args: {
      proof: Hex;
      payloadHash: Hex;
      onProgress: (stage: string) => void;
      beforeSpend: () => Promise<void>;
    }
  ) => {
    assert.equal(args.proof, vaa());
    assert.equal(args.payloadHash, keccak256(payload));
    state.solanaReceives++;
    for (const stage of ["Verify guardian signatures", "Post VAA", "Register proof"]) {
      await args.beforeSpend();
      args.onProgress(stage);
      if (scenario === "solana-stage-failure" && stage === "Post VAA")
        throw new Error("Post VAA rejected");
    }
    state.proven.add(sourceChainId.toString());
    return { attestSignature: "solana-origin-signature", attestation: "origin-attestation" };
  }
}));
mock.module("../../src/lib/libraries/wormholeProof", () => ({
  ...proofHelpers,
  findWormholePublication: async (
    _output: MandateOutput,
    message: WormholeExpectedMessage,
    hint?: WormholePublication
  ) => {
    state.finds++;
    assert.deepEqual(message, expected);
    if (hint) assert.deepEqual(hint, publication);
    return state.publication ?? null;
  },
  publishEvmWormhole: async (
    _output: MandateOutput,
    tagged: Hex,
    _wallet: WC,
    account: Hex,
    opts: { beforeSpend: () => Promise<void> }
  ) => {
    await opts.beforeSpend();
    assert.equal(tagged, payload);
    state.outputAccounts.push(account);
    assert.equal(account, EVM_ACCOUNT);
    state.publishes++;
    state.publication = publication;
    return publication;
  },
  saveWormholeHint: () => {},
  pollWormholeVaa: async (pub: WormholePublication, message: WormholeExpectedMessage) => {
    state.polls++;
    assert.deepEqual(pub, publication);
    assert.deepEqual(message, expected);
    if (state.pollMode === "transport")
      throw new Error("Couldn't reach Wormhole Scan. Retry to resume the same message.");
    if (state.pollMode === "pending") return { status: "pending" };
    return {
      status: "proof",
      proof:
        state.pollMode === "malformed"
          ? vaa(
              encodeFillDescription({
                orderId: ORDER_ID,
                output,
                solver: b32("c"),
                timestamp: TEST_NOW_SECONDS
              })
            )
          : vaa()
    };
  }
}));
// Loading after mock registration deliberately exercises the module-loading
// boundary; a static import would bind production dependencies first.
const { validateWormholeFill } = await import("../../src/lib/libraries/wormholeFill");
const options: WormholeFillOptions = {
  walletClient: wallet,
  inputAccount: () => (solanaInput ? b32("d") : INPUT_ACCOUNT),
  outputAccount: async () => EVM_ACCOUNT,
  solanaDeps: async (chainId) => ({ chainId }) as SolanaDeps,
  preHook: async (chainId) => {
    state.preparations.push(chainId);
  },
  postHook: async () => {
    state.posts++;
  },
  onProgress: (stage) => {
    state.stages.push(stage);
  }
};
const run = (chainId = sourceChainId) =>
  validateWormholeFill(
    { orderContainer, orderId: ORDER_ID, output, fillTransactionHash: TX, sourceChainId: chainId },
    options
  );

switch (scenario) {
  case "pending-retry": {
    state.pollMode = "pending";
    const result = await run();
    assert.deepEqual(result, { status: "pending", publication });
    assert.equal(state.posts, 0);
    assert.equal(state.evmReceives, 0);
    state.pollMode = "proof";
    assert.equal((await run()).status, "complete");
    assert.equal(state.publishes, 1);
    assert.equal(state.posts, 1);
    break;
  }
  case "transport-retry":
    state.pollMode = "transport";
    await assert.rejects(run(), /Couldn't reach Wormhole Scan/);
    assert.equal(state.posts, 0);
    state.pollMode = "proof";
    await run();
    assert.equal(state.publishes, 1);
    assert.equal(state.posts, 1);
    break;
  case "wallet-retry":
    state.rejectReceive = true;
    await assert.rejects(run(), /Wallet rejected registration/);
    assert.equal(state.posts, 0);
    state.rejectReceive = false;
    await run();
    assert.equal(state.publishes, 1);
    assert.equal(state.evmReceives, 2);
    assert.equal(state.posts, 1);
    break;
  case "third-party":
    state.proven.add(sourceChainId.toString());
    assert.equal((await run()).status, "complete");
    assert.equal(state.publishes, 0);
    assert.equal(state.finds, 0);
    assert.equal(state.polls, 0);
    assert.deepEqual(state.preparations, []);
    assert.equal(state.posts, 1);
    break;
  case "two-wallets":
    await run();
    assert.deepEqual(state.outputAccounts, [EVM_ACCOUNT]);
    assert.equal(state.solanaReceives, 1);
    assert.equal(state.evmReceives, 0);
    assert.equal(state.posts, 1);
    assert.ok(state.stages.includes("Verify guardian signatures"));
    assert.ok(state.stages.includes("Post VAA"));
    assert.ok(state.stages.includes("Register proof"));
    break;
  case "malformed-bound-proof":
    state.publication = publication;
    state.pollMode = "malformed";
    await assert.rejects(run(), /exact expected/);
    assert.deepEqual(state.preparations, []);
    assert.equal(state.evmReceives, 0);
    assert.equal(state.posts, 0);
    break;
  case "receipt-without-proof":
    state.receiveProves = false;
    await assert.rejects(run(), /not registered/);
    assert.equal(state.evmReceives, 1);
    assert.equal(state.posts, 0);
    break;
  case "solana-stage-failure":
    await assert.rejects(run(), /Post VAA rejected/);
    assert.equal(state.posts, 0);
    assert.ok(!state.stages.includes("Register proof"));
    break;
  case "solana-publication-singleflight": {
    state.pollMode = "pending";
    const results = await Promise.all([run(8453n), run(56n)]);
    assert.ok(results.every((result) => result.status === "pending"));
    assert.equal(state.publishes, 1);
    assert.equal(state.finds, 1);
    assert.equal(state.posts, 0);
    break;
  }
  case "delivery-singleflight":
    await Promise.all([run(), run()]);
    assert.equal(state.publishes, 1);
    assert.equal(state.evmReceives, 1);
    assert.equal(state.posts, 2);
    break;
  case "unavailable-route":
    state.ready = false;
    await assert.rejects(run(), /route unavailable/);
    assert.equal(state.publishes, 0);
    assert.deepEqual(state.preparations, []);
    assert.equal(state.posts, 0);
    break;
  default:
    throw new Error(`Unknown Wormhole fill scenario: ${scenario}`);
}
