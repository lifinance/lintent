import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import axios, { type AxiosRequestConfig } from "axios";
import {
  IntentApi,
  addressToBytes32,
  bytes32ToSolanaBase58,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_DEVNET_CHAIN_ID,
  TRON_MAINNET_CHAIN_ID
} from "@lifi/intent";
import { WORMHOLE_ORACLE } from "../../src/lib/config";
import {
  getVerifierQuotes,
  type QuoteOptions,
  type QuoteResponse
} from "../../src/lib/libraries/verifierQuote";

const BASE = 8453;
const ARBITRUM = 42161;
const SOLANA = Number(SOLANA_MAINNET_CHAIN_ID);
const USER = "0x1111111111111111111111111111111111111111";
const RECEIVER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const SOLVER = "0x4444444444444444444444444444444444444444";
const SOLANA_USER = `0x${"55".repeat(32)}` as const;
const SOLANA_TOKEN = `0x${"66".repeat(32)}` as const;
const SOLANA_SOLVER = `0x${"77".repeat(32)}` as const;
const SOLANA_ORACLE = bytes32ToSolanaBase58(WORMHOLE_ORACLE[SOLANA]!);

type RuntimeQuote = QuoteResponse["quotes"][number] & {
  metadata: { oracle?: { input: string; output: string } };
};
function quote(
  input: string = WORMHOLE_ORACLE[BASE]!,
  output: string = WORMHOLE_ORACLE[ARBITRUM]!,
  solver: string | string[] | null = SOLVER
): RuntimeQuote {
  return {
    quoteId: "wormhole-quote",
    provider: "solver",
    preview: {
      inputs: [{ chain: `eip155:${BASE}`, asset: TOKEN, amount: "1000000" }],
      outputs: [{ chain: `eip155:${ARBITRUM}`, asset: TOKEN, amount: "999000" }]
    },
    order: {
      type: "oif-user-open-v0",
      openIntentTx: { chain: `eip155:${BASE}`, to: USER, data: "0x", gasRequired: "1" },
      checks: { allowances: [] }
    },
    partialFill: false,
    failureHandling: "refund-claim",
    metadata: { oracle: { input, output }, exclusiveFor: solver }
  };
}
function options(): QuoteOptions {
  return {
    user: USER,
    userChainId: BASE,
    inputs: [{ chainId: BASE, sender: USER, asset: TOKEN, amount: 1000000n }],
    outputs: [{ chainId: ARBITRUM, receiver: RECEIVER, asset: TOKEN, amount: 0n }]
  };
}

const api = new IntentApi(true);
api.baseUrl = "https://quote.invalid/prefix";
let response: QuoteResponse;
const sdk = spyOn(api, "getQuotes");
type QuoteHttp = {
  post: (
    url: string,
    data: PostedIntent,
    config?: AxiosRequestConfig<PostedIntent>
  ) => Promise<{ data: QuoteResponse }>;
};
const quoteHttp: QuoteHttp = axios;
const http = spyOn(quoteHttp, "post");
beforeEach(() => {
  response = { quotes: [quote()] };
  sdk.mockClear();
  sdk.mockImplementation(async () => response);
  http.mockClear();
  http.mockImplementation(async () => ({
    data: response
  }));
});
afterEach(() => {
  // No module mocks: these spies remain local to the suite and are restored below.
  sdk.mockClear();
  http.mockClear();
});
afterAll(() => {
  sdk.mockRestore();
  http.mockRestore();
});

type PostedIntent = {
  user: { chain: string; address: string };
  intent: {
    intentType: string;
    swapType: string;
    inputs: { chain: string; user: string; asset: string; amount: string }[];
    outputs: { chain: string; receiver: string; asset: string; amount?: string }[];
    metadata: { oracle: { chain: string; address: string }[]; exclusiveFor?: string[] };
    minValidUntil?: number;
    preference?: string;
    partialFill?: boolean;
    failureHandling?: string[];
  };
  supportedTypes: string[];
};
function postedIntent(): PostedIntent {
  return http.mock.calls[0][1];
}

describe("verifier-constrained quotes", () => {
  test("Polymer and same-chain requests retain the SDK's existing response semantics", async () => {
    const request = options();
    response = { quotes: [{ ...quote(), metadata: { exclusiveFor: null } }] };
    expect(await getVerifierQuotes(api, request, "polymer")).toBe(response);
    request.outputs[0].chainId = BASE;
    expect(await getVerifierQuotes(api, request, "wormhole")).toBe(response);
    expect(sdk).toHaveBeenCalledTimes(2);
    expect(http).not.toHaveBeenCalled();
  });

  test("remote EVM quotes send both distinct native deployments and retain every v1 option", async () => {
    const request = options();
    request.user = addressToBytes32(USER);
    request.inputs[0].sender = addressToBytes32(USER);
    request.outputs[0].receiver = addressToBytes32(RECEIVER);
    request.exclusiveFor = [addressToBytes32(SOLVER)];
    request.integratorKey = "integrator-secret";
    request.minValidUntil = 1800000000;
    request.preference = "trust-minimization";
    request.partialFill = false;
    request.failureHandling = ["refund-claim"];
    request.swapType = "exact-output";
    expect((await getVerifierQuotes(api, request, "wormhole")).quotes).toHaveLength(1);
    const body = postedIntent();
    expect(body.user).toEqual({ chain: `eip155:${BASE}`, address: USER });
    expect(body.supportedTypes).toEqual(["oif-user-open-v0"]);
    expect(body.intent).toMatchObject({
      intentType: "oif-swap",
      swapType: "exact-output",
      minValidUntil: 1800000000,
      preference: "trust-minimization",
      partialFill: false,
      failureHandling: ["refund-claim"],
      inputs: [{ chain: `eip155:${BASE}`, user: USER, asset: TOKEN, amount: "1000000" }],
      outputs: [{ chain: `eip155:${ARBITRUM}`, receiver: RECEIVER, asset: TOKEN, amount: "0" }],
      metadata: {
        oracle: [
          { chain: `eip155:${BASE}`, address: WORMHOLE_ORACLE[BASE] },
          { chain: `eip155:${ARBITRUM}`, address: WORMHOLE_ORACLE[ARBITRUM] }
        ],
        exclusiveFor: [SOLVER]
      }
    });
    expect(body.intent).not.toHaveProperty("verifier");
    expect(http.mock.calls[0][0]).toBe("https://quote.invalid/api/v1/integrator/quote/request");
    expect(http.mock.calls[0][2]).toEqual({
      timeout: 15000,
      headers: { "X-Integrator-Key": "integrator-secret" }
    });
    expect(sdk).not.toHaveBeenCalled();
  });

  test("Base to Solana uses native recipient/mint and the state PDA, never the program ID", async () => {
    const request = options();
    request.outputs = [{ chainId: SOLANA, receiver: SOLANA_USER, asset: SOLANA_TOKEN }];
    response = { quotes: [quote(WORMHOLE_ORACLE[BASE]!, SOLANA_ORACLE)] };
    expect((await getVerifierQuotes(api, request, "wormhole")).quotes).toHaveLength(1);
    const body = postedIntent();
    expect(body.intent.swapType).toBe("exact-input");
    expect(body.intent.outputs[0]).toEqual({
      chain: `solana:${SOLANA}`,
      receiver: bytes32ToSolanaBase58(SOLANA_USER),
      asset: bytes32ToSolanaBase58(SOLANA_TOKEN)
    });
    expect(body.intent.metadata.oracle).toContainEqual({
      chain: `solana:${SOLANA}`,
      address: SOLANA_ORACLE
    });
    expect(body.intent.outputs[0]).not.toHaveProperty("amount");
    expect(body.intent.metadata).not.toHaveProperty("exclusiveFor");
  });

  test("Solana to Base keeps all 32 solver bytes while converting identities to base58", async () => {
    const request = options();
    request.userChainId = SOLANA;
    request.user = SOLANA_USER;
    request.inputs = [
      {
        chainId: SOLANA,
        sender: bytes32ToSolanaBase58(SOLANA_USER),
        asset: SOLANA_TOKEN,
        amount: 19n
      }
    ];
    request.outputs[0].chainId = BASE;
    request.exclusiveFor = [SOLANA_SOLVER];
    response = { quotes: [quote(SOLANA_ORACLE, WORMHOLE_ORACLE[BASE]!, SOLANA_SOLVER)] };
    const result = await getVerifierQuotes(api, request, "wormhole");
    expect(result.quotes[0].metadata.exclusiveFor).toBe(bytes32ToSolanaBase58(SOLANA_SOLVER));
    const body = postedIntent();
    expect(body.user).toEqual({
      chain: `solana:${SOLANA}`,
      address: bytes32ToSolanaBase58(SOLANA_USER)
    });
    expect(body.intent.inputs[0]).toEqual({
      chain: `solana:${SOLANA}`,
      user: bytes32ToSolanaBase58(SOLANA_USER),
      asset: bytes32ToSolanaBase58(SOLANA_TOKEN),
      amount: "19"
    });
    expect(body.intent.metadata.exclusiveFor).toEqual([bytes32ToSolanaBase58(SOLANA_SOLVER)]);
    expect(body.intent.metadata.oracle).toEqual([
      { chain: `solana:${SOLANA}`, address: SOLANA_ORACLE },
      { chain: `eip155:${BASE}`, address: WORMHOLE_ORACLE[BASE]! }
    ]);
  });

  test("constraints name every participating chain exactly once", async () => {
    const request = options();
    request.outputs.push({ ...request.outputs[0] }, { ...request.outputs[0], chainId: 1 });
    await getVerifierQuotes(api, request, "wormhole");
    expect(postedIntent().intent.metadata.oracle).toEqual([
      { chain: `eip155:${BASE}`, address: WORMHOLE_ORACLE[BASE]! },
      { chain: `eip155:${ARBITRUM}`, address: WORMHOLE_ORACLE[ARBITRUM]! },
      { chain: "eip155:1", address: WORMHOLE_ORACLE[1]! }
    ]);
  });

  test.each([
    ["Tron", Number(TRON_MAINNET_CHAIN_ID)],
    ["Solana devnet", Number(SOLANA_DEVNET_CHAIN_ID)],
    ["unregistered deployment", 999999],
    ["mixed Wormhole network", 84532]
  ])("%s returns no quote without sending an unfiltered request", async (_label, chainId) => {
    const request = options();
    request.outputs[0].chainId = chainId;
    expect(await getVerifierQuotes(api, request, "wormhole")).toEqual({ quotes: [] });
    expect(http).not.toHaveBeenCalled();
    expect(sdk).not.toHaveBeenCalled();
  });

  test("empty sides and incompatible multichain input oracles cannot request a quote", async () => {
    const cases = [options(), options(), options()];
    cases[0].inputs = [];
    cases[1].outputs = [];
    cases[2].inputs.push({ ...cases[2].inputs[0], chainId: ARBITRUM });
    for (const request of cases)
      expect(await getVerifierQuotes(api, request, "wormhole")).toEqual({ quotes: [] });
    expect(http).not.toHaveBeenCalled();
    expect(sdk).not.toHaveBeenCalled();
  });

  test("missing, swapped, source-as-destination, dirty, and Polymer metadata cannot become eligible", async () => {
    const missing = { ...quote(), metadata: { exclusiveFor: SOLVER } };
    const dirty = `0x01${addressToBytes32(WORMHOLE_ORACLE[BASE]!).slice(4)}`;
    response = {
      quotes: [
        missing,
        quote(WORMHOLE_ORACLE[ARBITRUM]!, WORMHOLE_ORACLE[BASE]!),
        quote(WORMHOLE_ORACLE[BASE]!, WORMHOLE_ORACLE[BASE]!),
        quote(dirty),
        quote("0x008c3800f3ad9b3b662d002e90cc00000000ee17"),
        quote(
          addressToBytes32(WORMHOLE_ORACLE[BASE]!),
          addressToBytes32(WORMHOLE_ORACLE[ARBITRUM]!),
          addressToBytes32(SOLVER)
        )
      ]
    };
    const result = await getVerifierQuotes(api, options(), "wormhole");
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0].metadata.exclusiveFor).toBe(SOLVER);
  });

  test("Solana program ID metadata cannot masquerade as its oracle state PDA", async () => {
    const request = options();
    request.outputs[0].chainId = SOLANA;
    request.outputs[0].receiver = SOLANA_USER;
    request.outputs[0].asset = SOLANA_TOKEN;
    response = {
      quotes: [quote(WORMHOLE_ORACLE[BASE]!, "LiFixrxyzmt1Degd42wQCsQNhDNLjbrRwtwopX5VUrt")]
    };
    expect(await getVerifierQuotes(api, request, "wormhole")).toEqual({ quotes: [] });
  });

  test("malformed EVM padding cannot reach the quote service as a truncated user", async () => {
    const request = options();
    request.user = SOLANA_USER;
    await expect(getVerifierQuotes(api, request, "wormhole")).rejects.toThrow(
      "non-zero EVM padding"
    );
    expect(http).not.toHaveBeenCalled();
    expect(sdk).not.toHaveBeenCalled();
  });

  test("a response cannot attest only the first of distinct destination oracles", async () => {
    const request = options();
    request.outputs.push({ ...request.outputs[0], chainId: 1 });
    expect(await getVerifierQuotes(api, request, "wormhole")).toEqual({ quotes: [] });
  });

  test("a malformed origin solver is dropped rather than silently truncated", async () => {
    response = { quotes: [quote(undefined, undefined, SOLANA_SOLVER)] };
    expect(await getVerifierQuotes(api, options(), "wormhole")).toEqual({ quotes: [] });
  });

  test("transport errors never retry through the unfiltered SDK", async () => {
    http.mockRejectedValueOnce(new Error("quote transport unavailable"));
    await expect(getVerifierQuotes(api, options(), "wormhole")).rejects.toThrow(
      "quote transport unavailable"
    );
    expect(http).toHaveBeenCalledTimes(1);
    expect(sdk).not.toHaveBeenCalled();
  });
});
