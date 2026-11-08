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
import {
  IntentApi,
  addressToBytes32,
  bytes32ToAddress,
  encodeStellarOrder,
  stellarAddressCommitment,
  stellarStrkeyToBytes32
} from "@lifi/intent";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  maxUint256,
  padHex,
  parseAbiParameters,
  stringToHex
} from "viem";
import { AXELAR_ORACLE_ABI } from "../../src/lib/abi/axelaroracle";
import { COIN_FILLER_ABI } from "../../src/lib/abi/outputsettler";
import { AXELAR_NETWORKS, STELLAR_TESTNET_ID } from "../../src/lib/axelarNetworks";
import type { ApiQuoteContext, SelectedApiQuote } from "../../src/lib/libraries/apiQuote";
import type { WC } from "../../src/lib/config";
import { makeStandardOrder } from "./orderFixtures";

const NOW_MS = 1_800_000_000_000;
const FILL_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROOF_HASH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BASE_SEPOLIA = 84532;

// Child process: module mocks would leak into the rest of the unit suite.
export async function runIntentLifecycle() {
  Date.now = () => NOW_MS;
  let releaseStale: () => void = () => {};
  const staleHeld = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  const staleEntered = Promise.withResolvers<void>();

  const testnet = AXELAR_NETWORKS.testnet;
  const baseSepolia = testnet.evm[BASE_SEPOLIA]!;
  const config = { ...(await import("../../src/lib/config")) };
  const stellarUser = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4));
  const evmUser = "0x1111111111111111111111111111111111111111" as const;
  const wire = (value: string) =>
    value.startsWith("C") || value.startsWith("G")
      ? stellarStrkeyToBytes32(value)
      : addressToBytes32(value as `0x${string}`);
  const baseSettler = "0x75220b7600c300005038432a0000f308e0000068";
  const inputAmount = 1_000_000n;
  const outputAmount = 100_000n;
  const solver = stellarAddressCommitment(stellarUser);
  const destinationName = config.AXELAR_CHAIN_NAMES[STELLAR_TESTNET_ID]!;
  const chainKey = BigInt(padHex(stringToHex(destinationName), { size: 32, dir: "right" }));

  function buildQuote(opts: {
    quoteId: string;
    nonce: bigint;
    expires: number;
    fillDeadline: number;
    validUntil: number;
  }): SelectedApiQuote {
    const order = makeStandardOrder({
      user: wire(stellarUser),
      nonce: opts.nonce,
      originChainId: BigInt(STELLAR_TESTNET_ID),
      expires: opts.expires,
      fillDeadline: opts.fillDeadline,
      inputOracle: wire(testnet.stellar.oracle),
      inputs: [[BigInt(wire(testnet.stellar.usdc)), inputAmount]],
      outputs: [
        {
          chainId: BigInt(BASE_SEPOLIA),
          token: wire(baseSepolia.usdc),
          amount: outputAmount,
          oracle: wire(baseSepolia.oracle),
          settler: wire(baseSettler),
          recipient: wire(evmUser),
          callbackData: "0x",
          context: "0x"
        }
      ]
    });
    return {
      quoteId: opts.quoteId,
      provider: "synthetic",
      validUntil: opts.validUntil,
      preview: {
        inputs: [
          {
            chain: `stellar:${STELLAR_TESTNET_ID}`,
            user: stellarUser,
            asset: testnet.stellar.usdc,
            amount: String(inputAmount)
          }
        ],
        outputs: [
          {
            chain: `eip155:${BASE_SEPOLIA}`,
            receiver: evmUser,
            asset: baseSepolia.usdc,
            amount: String(outputAmount)
          }
        ]
      },
      order: {
        type: "oif-user-open-v0",
        openIntentTx: {
          chain: `stellar:${STELLAR_TESTNET_ID}`,
          to: testnet.stellar.inputEscrow,
          data: Buffer.from(encodeStellarOrder(order)).toString("base64")
        },
        checks: { allowances: [] }
      },
      partialFill: false,
      failureHandling: "refund-claim",
      metadata: {
        exclusiveFor: null,
        oracle: { input: order.inputOracle, output: order.outputs[0].oracle },
        quoteReference: `0x${opts.nonce.toString(16)}`
      }
    };
  }

  const freshExpires = 1_800_003_600;
  const freshQuote = buildQuote({
    quoteId: "fresh-quote",
    nonce: 0x1234n,
    expires: freshExpires,
    fillDeadline: 1_800_003_000,
    validUntil: freshExpires
  });
  const staleQuote = buildQuote({
    quoteId: "stale-quote",
    nonce: 0x1235n,
    expires: freshExpires,
    fillDeadline: 1_800_003_000,
    validUntil: freshExpires
  });
  const expiredQuote = buildQuote({
    quoteId: "expired-quote",
    nonce: 0x1236n,
    expires: freshExpires,
    fillDeadline: 1_800_003_000,
    validUntil: 1_800_000_000
  });
  const expiredIntent = buildQuote({
    quoteId: "expired-intent",
    nonce: 0x1237n,
    expires: 1_700_000_000,
    fillDeadline: 1_699_999_000,
    validUntil: freshExpires
  });

  let quoteCalls = 0;
  function quoteSequence() {
    quoteCalls += 1;
    return quoteCalls;
  }
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: unknown) => {
        const url = requestUrl(input);
        if (!url.includes("/api/v1/integrator/quote/request")) {
          throw new Error(`Unexpected network request ${url}`);
        }
        const seq = quoteSequence();
        if (seq === 1) {
          staleEntered.resolve();
          await staleHeld;
          return Response.json({ quotes: [staleQuote] });
        }
        if (seq === 2) return Response.json({ quotes: [freshQuote] });
        throw new Error(`Unexpected quote request ${seq}`);
      },
      { preconnect: () => {} }
    )
  );

  const coins = config.coinList(false);
  const context: ApiQuoteContext = {
    inputs: [
      {
        token: coins.find(
          (token) => token.chainId === STELLAR_TESTNET_ID && token.name === "usdc"
        )!,
        amount: inputAmount
      }
    ],
    outputs: [
      {
        token: coins.find((token) => token.chainId === BASE_SEPOLIA && token.name === "usdc")!,
        amount: 0n
      }
    ],
    user: stellarUser,
    recipient: evmUser,
    mainnet: false,
    verifier: "axelar",
    lockType: "escrow"
  };

  let fillReceipt: ReturnType<typeof outputFilledReceipt>;
  const stellarOpens: string[] = [];
  const fills: { address: string; args: readonly unknown[] }[] = [];
  const proofs: { to: string; data: string; value: bigint }[] = [];
  const receipts = new Map<string, { logs?: unknown[] }>();
  let selection: { quote: SelectedApiQuote | undefined; generation: number } = {
    quote: undefined,
    generation: 0
  };
  let savedOrder = false;

  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "allowance") return maxUint256;
      if (functionName === "chainIdMap") return BigInt(STELLAR_TESTNET_ID);
      if (functionName === "reverseChainIdMap") return chainKey;
      throw new Error(`Unexpected contract read ${functionName}`);
    },
    getBlock: async () => ({ number: 10n }),
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const cached = receipts.get(hash);
      if (cached) return cached;
      throw new Error(`No receipt for ${hash}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
      if (hash === FILL_HASH) return fillReceipt;
      if (hash === PROOF_HASH) return { status: "success", logs: [] };
      throw new Error(`Unexpected receipt wait ${hash}`);
    }
  };
  mock.module("../../src/lib/config", () => ({ ...config, getClient: () => client }));
  const storeMock = {
    stellarAccounts: { [STELLAR_TESTNET_ID]: stellarUser },
    connectedAccount: { address: evmUser },
    saveStellarTransaction: async () => {},
    saveTransactionReceipt: async (
      _chainId: number | bigint,
      hash: string,
      receipt: { logs?: unknown[] }
    ) => {
      receipts.set(hash, receipt);
    },
    getTransactionReceipt: (_chainId: number | bigint, hash: string) => receipts.get(hash),
    getStellarTransaction: () => undefined,
    saveOrderToDb: async () => {
      savedOrder = true;
    }
  };
  mock.module("../../src/lib/state.svelte", () => ({
    default: storeMock,
    store: storeMock
  }));
  const unused = () => {
    throw new Error("Unexpected non-API execution");
  };
  mock.module("../../src/lib/libraries/intentExecution", () => ({
    depositAndRegisterCompact: unused,
    openEscrowIntent: unused,
    signIntentCompact: unused,
    finaliseIntent: unused
  }));
  mock.module("../../src/lib/tron/client", () => ({
    getTronReads: unused,
    getTronSigner: unused
  }));
  mock.module("axios", () => ({
    default: {
      post: async (url: string) => {
        if (url !== "/axelar/gas") throw new Error(`Unexpected axios ${url}`);
        return { data: { fee: "1000" } };
      }
    }
  }));
  mock.module("@stellar/freighter-api", () => ({
    getAddress: unused,
    isConnected: unused,
    requestAccess: unused,
    getNetworkDetails: async () => ({
      networkPassphrase: config.stellarNetwork(STELLAR_TESTNET_ID).passphrase
    }),
    signTransaction: async (xdr: string) => {
      stellarOpens.push(xdr);
      return { signedTxXdr: xdr };
    }
  }));
  spyOn(rpc.Server.prototype, "getAccount").mockImplementation(
    async () => new Account(stellarUser, "1")
  );
  spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
  spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation(async () => {
    const hash = stellarOpens.length.toString(16).padStart(64, "ab");
    return { status: "PENDING", hash } as never;
  });
  spyOn(rpc.Server.prototype, "getTransaction").mockImplementation(
    async () => ({ status: "SUCCESS", ledger: 1, createdAt: 1_800_000_100 }) as never
  );

  const { validateApiQuote } = await import("../../src/lib/libraries/apiQuote");
  const { containerToIntent } = await import("../../src/lib/utils/intent");
  const { IntentFactory } = await import("../../src/lib/libraries/intentFactory");
  const { Solver } = await import("../../src/lib/libraries/solver");

  const validatedFresh = validateApiQuote(freshQuote, {
    ...context,
    outputs: [{ ...context.outputs[0], amount: outputAmount }]
  });
  const orderId = containerToIntent({
    order: validatedFresh.order,
    inputSettler: validatedFresh.inputSettler,
    sponsorSignature: { type: "None", payload: "0x" },
    allocatorSignature: { type: "None", payload: "0x" }
  }).orderId();
  const output = validatedFresh.order.outputs[0];
  fillReceipt = outputFilledReceipt(orderId, solver, 1_800_000_100, output);

  const wallet = {
    getAddresses: async () => [evmUser],
    getChainId: async () => BASE_SEPOLIA,
    writeContract: async (tx: {
      address: string;
      args: readonly unknown[];
      functionName: string;
    }) => {
      if (tx.functionName !== "fillOrderOutputs") throw new Error(tx.functionName);
      fills.push({ address: tx.address, args: tx.args });
      return FILL_HASH;
    },
    sendTransaction: async (tx: { to: string; data: string; value?: bigint }) => {
      proofs.push({ to: tx.to, data: tx.data, value: tx.value ?? 0n });
      return PROOF_HASH;
    }
  } as unknown as WC;
  const factory = new IntentFactory({
    walletClient: wallet,
    apiQuoteContext: () => context,
    apiQuoteSelection: () => selection
  });

  async function messageOf(run: () => Promise<unknown> | unknown) {
    try {
      await run();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  context.outputs[0].amount = outputAmount;
  selection = { quote: expiredQuote, generation: 1 };
  const expiredQuoteError = await messageOf(() => validateApiQuote(expiredQuote, context));
  const expiredQuoteOpens = stellarOpens.length;
  const expiredQuoteExecute = await messageOf(() => factory.executeApiQuote(expiredQuote));
  selection = { quote: expiredIntent, generation: 2 };
  const expiredIntentError = await messageOf(() => validateApiQuote(expiredIntent, context));
  const expiredIntentExecute = await messageOf(() => factory.executeApiQuote(expiredIntent));
  const opensAfterExpiry = stellarOpens.length;
  assert.equal(expiredQuoteOpens, 0);
  assert.equal(opensAfterExpiry, expiredQuoteOpens);

  // Same rule as GetQuote.updateQuote: capture the generation before the
  // order-API round trip and drop the response if a newer request started.
  let generation = 0;
  async function requestQuote() {
    const requestId = ++generation;
    selection = { quote: undefined, generation: requestId };
    const response = await new IntentApi(true).getQuotes(
      (await import("../../src/lib/libraries/apiQuote")).apiQuoteRequest(context)
    );
    const quote = response.quotes[0];
    if (requestId !== generation) return { applied: false, quote };
    validateApiQuote(quote, context);
    context.outputs[0].amount = BigInt(quote.preview.outputs[0].amount);
    selection = { quote, generation: requestId };
    return { applied: true, quote };
  }

  const firstRequest = requestQuote();
  await staleEntered.promise;
  const secondRequest = await requestQuote();
  releaseStale();
  const firstResult = await firstRequest;
  const staleExecute = await messageOf(() => factory.executeApiQuote(firstResult.quote));
  const opensAfterStale = stellarOpens.length;

  const stages: string[] = [];
  const openHash = await factory.executeApiQuote(secondRequest.quote);
  stages.push("lock", "issue");
  assert.equal(savedOrder, true);
  assert.ok(openHash.startsWith("0x"));
  const saved = selection.quote;
  assert.ok(saved);
  const filled = await Solver.fill(
    wallet,
    { orderContainer: await issuedContainer(), outputs: [output] },
    { account: () => evmUser }
  )();
  stages.push("solve");
  const proved = await Solver.validate(
    wallet,
    {
      output,
      orderContainer: await issuedContainer(),
      fillTransactionHash: filled as string,
      sourceChainId: STELLAR_TESTNET_ID,
      mainnet: false
    },
    { account: () => evmUser }
  )();
  stages.push("proof");
  await Solver.claim(
    wallet,
    {
      orderContainer: await issuedContainer(),
      fillTransactionHashes: [filled as string],
      sourceChainId: STELLAR_TESTNET_ID
    },
    { account: () => evmUser }
  )();
  stages.push("finalise");

  async function issuedContainer() {
    const { validateApiQuoteExecution } = await import("../../src/lib/libraries/apiQuote");
    const validated = validateApiQuoteExecution(secondRequest.quote, context);
    return {
      order: validated.order,
      inputSettler: validated.inputSettler,
      sponsorSignature: { type: "None" as const, payload: "0x" as const },
      allocatorSignature: { type: "None" as const, payload: "0x" as const }
    };
  }

  const invocations = stellarOpens.map(invocation);
  const proof = proofs[0];
  const decodedProof = decodeFunctionData({
    abi: AXELAR_ORACLE_ABI,
    data: proof.data as `0x${string}`
  });

  return {
    expiredQuoteError,
    expiredQuoteExecute,
    expiredIntentError,
    expiredIntentExecute,
    opensAfterExpiry,
    staleApplied: firstResult.applied,
    freshApplied: secondRequest.applied,
    selectedQuoteId: selection.quote?.quoteId,
    staleExecute,
    opensAfterStale,
    stages,
    open: invocations[0],
    freshPayload: secondRequest.quote.order.openIntentTx.data,
    fill: {
      address: fills[0]?.address,
      orderId: fills[0]?.args[0],
      fillDeadline: fills[0]?.args[2],
      solver: fills[0]?.args[3]
    },
    expectedSolver: solver,
    expectedOrderId: orderId,
    proof: {
      to: proof.to,
      value: proof.value.toString(),
      destination: decodedProof.args[0],
      recipient: decodedProof.args[1],
      selector: proof.data.slice(0, 10)
    },
    finalise: invocations[1],
    proved: typeof proved === "object" && proved !== null && "submitTxHash" in proved,
    corridor: {
      origin: STELLAR_TESTNET_ID,
      destination: BASE_SEPOLIA,
      escrow: testnet.stellar.inputEscrow,
      generation: config.axelarCorridor(STELLAR_TESTNET_ID, BASE_SEPOLIA).network.generation
    }
  };

  function invocation(xdr: string) {
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
    ) {
      throw new Error("Not a contract invocation");
    }
    return {
      contract: Address.fromScAddress(operation.func.invokeContract.contractAddress).toString(),
      method: operation.func.invokeContract.functionName.toString(),
      arg: operation.func.invokeContract.args[0].toXDR("base64")
    };
  }
}

function requestUrl(input: unknown) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === "object" && "url" in input) return String(input.url);
  return String(input);
}

function outputFilledReceipt(
  orderId: `0x${string}`,
  solver: `0x${string}`,
  timestamp: number,
  output: {
    oracle: `0x${string}`;
    settler: `0x${string}`;
    chainId: bigint;
    token: `0x${string}`;
    amount: bigint;
    recipient: `0x${string}`;
    callbackData: `0x${string}`;
    context: `0x${string}`;
  }
) {
  const topics = encodeEventTopics({
    abi: COIN_FILLER_ABI,
    eventName: "OutputFilled",
    args: { orderId }
  });
  const data = encodeAbiParameters(
    parseAbiParameters(
      "bytes32, uint32, (bytes32, bytes32, uint256, bytes32, uint256, bytes32, bytes, bytes), uint256"
    ),
    [
      solver,
      timestamp,
      [
        output.oracle,
        output.settler,
        output.chainId,
        output.token,
        output.amount,
        output.recipient,
        output.callbackData,
        output.context
      ],
      output.amount
    ]
  );
  return {
    status: "success" as const,
    logs: [
      {
        address: bytes32ToAddress(output.settler),
        topics,
        data,
        blockNumber: 1n,
        transactionHash: FILL_HASH,
        logIndex: 0,
        transactionIndex: 0,
        blockHash: `0x${"33".repeat(32)}` as const,
        removed: false
      }
    ]
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runIntentLifecycle()));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  }
}
