import assert from "node:assert/strict";
import { mock, spyOn } from "bun:test";
import {
  Account,
  Address,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc
} from "@stellar/stellar-sdk";
import { addressToBytes32, encodeStellarOrder, stellarStrkeyToBytes32 } from "@lifi/intent";
import { encodeFunctionData } from "viem";
import { SETTLER_ESCROW_ABI } from "../../src/lib/abi/escrow";
import {
  STELLAR_TESTNET_ID,
  STELLAR_TESTNET_USDC,
  BASE_TESTNET_USDC
} from "../../src/lib/stellarTestnet";
import type { ApiQuoteContext, SelectedApiQuote } from "../../src/lib/libraries/apiQuote";
import type { WC } from "../../src/lib/config";
import { makeStandardOrder } from "./orderFixtures";

export type ExecutionWindow =
  | "allowance-read"
  | "approval"
  | "wallet-recheck"
  | "stellar-prepare"
  | "stellar-network";
export type SelectionMutation =
  | "clear"
  | "replace"
  | "generation"
  | "output"
  | "round-trip"
  | "unchanged";

// Run once per child process: module/transport mocks cannot contaminate other unit files.
export async function runExecutionScenario(window: ExecutionWindow, mutation: SelectionMutation) {
  Date.now = () => 1_800_000_000_000;
  const rejectNetwork = (): never => {
    throw new Error("Unexpected network request");
  };
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => rejectNetwork(), { preconnect: rejectNetwork })
  );
  const deployment = {
    schemaVersion: 1,
    corridor: "stellar-testnet-base-sepolia",
    addressProvenance: "deployment-record",
    stellar: {
      inputEscrow: StrKey.encodeContract(Buffer.alloc(32, 1)),
      outputSettler: StrKey.encodeContract(Buffer.alloc(32, 2)),
      axelarOracle: StrKey.encodeContract(Buffer.alloc(32, 3))
    },
    baseSepolia: { axelarOracle: "0x7777777777777777777777777777777777777777" }
  };
  mock.module("$env/dynamic/public", () => ({
    env: {
      PUBLIC_STELLAR_TESTNET_ENABLED: "true",
      PUBLIC_STELLAR_TESTNET_DEPLOYMENT_JSON: JSON.stringify(deployment)
    }
  }));
  const config = { ...(await import("../../src/lib/config")) };
  const stellarOrigin = window.startsWith("stellar");
  const evmUser = "0x1111111111111111111111111111111111111111" as const;
  const stellarUser = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4));
  const inputChain = stellarOrigin ? STELLAR_TESTNET_ID : 84532;
  const outputChain = stellarOrigin ? 84532 : STELLAR_TESTNET_ID;
  const user = stellarOrigin ? stellarUser : evmUser;
  const recipient = stellarOrigin ? evmUser : stellarUser;
  const wire = (value: string) =>
    value.startsWith("C") || value.startsWith("G")
      ? stellarStrkeyToBytes32(value)
      : addressToBytes32(value as `0x${string}`);
  const baseEscrow = "0x00fc00edbe7c003b006f870068c548940000223e";
  const baseSettler = "0x75220b7600c300005038432a0000f308e0000068";
  const inputAsset = stellarOrigin ? STELLAR_TESTNET_USDC : BASE_TESTNET_USDC;
  const outputAsset = stellarOrigin ? BASE_TESTNET_USDC : STELLAR_TESTNET_USDC;
  const inputAmount = stellarOrigin ? 1000000n : 100000n;
  const outputAmount = stellarOrigin ? 100000n : 1000000n;
  const order = makeStandardOrder({
    user: stellarOrigin ? wire(user) : evmUser,
    nonce: 0x1234n,
    originChainId: BigInt(inputChain),
    expires: 1_800_003_600,
    fillDeadline: 1_800_003_000,
    inputOracle: stellarOrigin
      ? wire(deployment.stellar.axelarOracle)
      : (deployment.baseSepolia.axelarOracle as `0x${string}`),
    inputs: [[BigInt(wire(inputAsset)), inputAmount]],
    outputs: [
      {
        chainId: BigInt(outputChain),
        token: wire(outputAsset),
        amount: outputAmount,
        oracle: wire(
          stellarOrigin ? deployment.baseSepolia.axelarOracle : deployment.stellar.axelarOracle
        ),
        settler: wire(stellarOrigin ? baseSettler : deployment.stellar.outputSettler),
        recipient: wire(recipient),
        callbackData: "0x",
        context: stellarOrigin ? "0x" : "0x00"
      }
    ]
  });
  const quote: SelectedApiQuote = {
    quoteId: "synthetic-deferred",
    provider: "synthetic",
    validUntil: order.expires,
    preview: {
      inputs: [
        {
          chain: `${stellarOrigin ? "stellar" : "eip155"}:${inputChain}`,
          user,
          asset: inputAsset,
          amount: String(inputAmount)
        }
      ],
      outputs: [
        {
          chain: `${stellarOrigin ? "eip155" : "stellar"}:${outputChain}`,
          receiver: recipient,
          asset: outputAsset,
          amount: String(outputAmount)
        }
      ]
    },
    order: {
      type: "oif-user-open-v0",
      openIntentTx: stellarOrigin
        ? {
            chain: `stellar:${inputChain}`,
            to: deployment.stellar.inputEscrow,
            data: Buffer.from(encodeStellarOrder(order)).toString("base64")
          }
        : {
            chain: `eip155:${inputChain}`,
            to: baseEscrow,
            data: encodeFunctionData({
              abi: SETTLER_ESCROW_ABI,
              functionName: "open",
              args: [order]
            }),
            value: "0",
            gasRequired: "500000"
          },
      checks: {
        allowances: stellarOrigin
          ? []
          : [
              {
                chain: `eip155:${inputChain}`,
                token: inputAsset,
                user,
                spender: baseEscrow,
                required: String(inputAmount)
              }
            ]
      }
    },
    partialFill: false,
    failureHandling: "refund-claim",
    metadata: {
      exclusiveFor: null,
      oracle: { input: order.inputOracle, output: order.outputs[0].oracle },
      quoteReference: "0x1234"
    }
  };
  const coins = config.coinList(false);
  const context: ApiQuoteContext = {
    inputs: [
      {
        token: coins.find((t) => t.chainId === inputChain && t.name === "usdc")!,
        amount: inputAmount
      }
    ],
    outputs: [
      { token: coins.find((t) => t.chainId === outputChain && t.name === "usdc")!, amount: 0n }
    ],
    user,
    recipient,
    mainnet: false,
    verifier: "axelar",
    lockType: "escrow"
  };
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let paused = false;
  async function pause(point: ExecutionWindow) {
    if (point === window && !paused) {
      paused = true;
      reached.resolve();
      await release.promise;
    }
  }
  let approvalSignings = 0;
  const evmOpens: Record<string, unknown>[] = [];
  const stellarOpens: string[] = [];
  let addressReads = 0;
  const client = {
    readContract: async () => {
      await pause("allowance-read");
      return 0n;
    },
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
      if (hash === "0x01") await pause("approval");
      return { status: "success" };
    }
  };
  mock.module("../../src/lib/config", () => ({ ...config, getClient: () => client }));
  mock.module("../../src/lib/state.svelte", () => ({
    store: {
      stellarAccounts: { [STELLAR_TESTNET_ID]: stellarUser },
      saveStellarTransaction: async () => {},
      saveTransactionReceipt: async () => {},
      saveOrderToDb: async () => {}
    }
  }));
  const unused = () => {
    throw new Error("Unexpected non-API execution");
  };
  mock.module("../../src/lib/libraries/intentExecution", () => ({
    depositAndRegisterCompact: unused,
    openEscrowIntent: unused,
    signIntentCompact: unused
  }));
  mock.module("@stellar/freighter-api", () => ({
    getAddress: unused,
    isConnected: unused,
    requestAccess: unused,
    getNetworkDetails: async () => {
      await pause("stellar-network");
      return { networkPassphrase: config.stellarNetwork(STELLAR_TESTNET_ID).passphrase };
    },
    signTransaction: async (xdr: string) => {
      stellarOpens.push(xdr);
      return { signedTxXdr: xdr };
    }
  }));
  spyOn(rpc.Server.prototype, "getAccount").mockImplementation(
    async () => new Account(stellarUser, "1")
  );
  spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => {
    await pause("stellar-prepare");
    return tx as never;
  });
  spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation(
    async () => ({ status: "PENDING", hash: "ab".repeat(32) }) as never
  );
  spyOn(rpc.Server.prototype, "getTransaction").mockImplementation(
    async () => ({ status: "SUCCESS", ledger: 1, createdAt: 1_800_000_000 }) as never
  );
  const wallet = {
    getAddresses: async () => {
      addressReads++;
      return [evmUser];
    },
    getChainId: async () => {
      if (addressReads > 1) await pause("wallet-recheck");
      return 84532;
    },
    writeContract: async () => {
      approvalSignings++;
      return "0x01";
    },
    sendTransaction: async (tx: Record<string, unknown>) => {
      evmOpens.push(tx);
      return "0x02";
    }
  } as unknown as WC;
  const { validateApiQuote } = await import("../../src/lib/libraries/apiQuote");
  // Selection validation intentionally accepts the pre-quote output placeholder.
  validateApiQuote(quote, context);
  context.outputs[0].amount = outputAmount;
  let selection: { quote: SelectedApiQuote | undefined; generation: number } = {
    quote,
    generation: 1
  };
  const { IntentFactory } = await import("../../src/lib/libraries/intentFactory");
  const factory = new IntentFactory({
    mainnet: false,
    walletClient: wallet,
    apiQuoteContext: () => context,
    apiQuoteSelection: () => selection
  });
  const execution = factory.executeApiQuote(quote).then(
    (hash) => ({ hash, error: undefined }),
    (error) => ({ hash: undefined, error: String(error) })
  );
  await Promise.race([
    reached.promise,
    execution.then((result) => {
      throw new Error(`Execution did not reach ${window}: ${JSON.stringify(result)}`);
    })
  ]);
  if (mutation === "clear") selection = { quote: undefined, generation: selection.generation + 1 };
  if (mutation === "replace")
    selection = { quote: structuredClone(quote), generation: selection.generation };
  if (mutation === "generation") selection.generation++;
  if (mutation === "output") context.outputs[0].amount++;
  if (mutation === "round-trip") {
    selection = { quote: undefined, generation: selection.generation + 1 };
    context.outputs[0].amount++;
    selection = { quote, generation: selection.generation };
    context.outputs[0].amount = outputAmount;
  }
  release.resolve();
  const result = await execution;
  for (const tx of evmOpens) {
    assert.equal(tx.to, quote.order.openIntentTx.to);
    assert.equal(tx.data, quote.order.openIntentTx.data);
    assert.equal(tx.value, BigInt(quote.order.openIntentTx.value ?? "0"));
  }
  for (const xdr of stellarOpens) {
    const tx = TransactionBuilder.fromXDR(
      xdr,
      config.stellarNetwork(STELLAR_TESTNET_ID).passphrase
    );
    assert.ok(tx instanceof Transaction);
    const operation = tx.operations[0];
    assert.equal(operation.type, "invokeHostFunction");
    if (
      operation.type !== "invokeHostFunction" ||
      operation.func.type !== "hostFunctionTypeInvokeContract"
    )
      throw new Error("Not an open invocation");
    assert.equal(
      Address.fromScAddress(operation.func.invokeContract.contractAddress).toString(),
      quote.order.openIntentTx.to
    );
    assert.equal(operation.func.invokeContract.functionName.toString(), "open");
    assert.equal(
      operation.func.invokeContract.args[0].toXDR("base64"),
      quote.order.openIntentTx.data
    );
  }
  return {
    window,
    mutation,
    rejected: !!result.error,
    error: result.error,
    approvalSignings,
    openSignings: evmOpens.length + stellarOpens.length,
    payloadPreserved: !!(evmOpens.length + stellarOpens.length)
  };
}

if (import.meta.main) {
  console.log(
    JSON.stringify(
      await runExecutionScenario(
        process.argv[2] as ExecutionWindow,
        process.argv[3] as SelectionMutation
      )
    )
  );
}
