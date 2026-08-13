import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { EXPECTED_TOPIC0 } from "../../src/lib/libraries/provableEvents";

// `$env/static/private` is a Vite virtual module with no file behind it, so the real one can
// never resolve under `bun test`. Stub it before importing the module under test.
mock.module("$env/static/private", () => ({
  PRIVATE_POLYMER_MAINNET_ZONE_API_KEY: "mainnet-key",
  PRIVATE_POLYMER_TESTNET_ZONE_API_KEY: "testnet-key",
  PRIVATE_ROUTEMESH_API_KEY: "routemesh-key"
}));

// The Solana source path reads its optional RPC URL from `$env/dynamic/private`.
mock.module("$env/dynamic/private", () => ({ env: {} }));

type PolymerCall = { url: string; method: string; params: unknown[]; auth: string };

const polymerCalls: PolymerCall[] = [];
let verifyCalls = 0;
let verifyResult: "match" | "mismatch" | "unknown" = "match";
let queryProofResult: unknown = { jobID: 1, createdAt: 0, updatedAt: 0, status: "initialized" };

// Drive the real `verifyProvableLog` through its RPC instead of `mock.module`-ing it: bun runs
// every test file in one process and module mocks are global, so stubbing that path clobbered
// provableLogVerify.test.ts's own subject. Intercepting fetch also means these tests exercise
// the actual gate rather than a stand-in for it.
const realFetch = global.fetch;
global.fetch = (async (_url: string, init?: RequestInit) => {
  const call = JSON.parse(String(init?.body)) as { method: string };
  if (call.method !== "eth_getLogs") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 });
  }
  verifyCalls += 1;
  if (verifyResult === "unknown") throw new Error("rpc down");
  const result =
    verifyResult === "match"
      ? [
          {
            address: "0x75220b7600c300005038432a0000f308e0000068",
            topics: [EXPECTED_TOPIC0.OutputFilled, `0x${"11".repeat(32)}`],
            data: "0x",
            blockNumber: "0x64",
            blockHash: `0x${"22".repeat(32)}`,
            transactionHash: `0x${"33".repeat(32)}`,
            transactionIndex: "0x0",
            logIndex: "0x4",
            removed: false
          },
          // logIndex 0 too, so the "globalLogIndex may be 0" case has something to match.
          {
            address: "0x75220b7600c300005038432a0000f308e0000068",
            topics: [EXPECTED_TOPIC0.OutputNotFilled, `0x${"11".repeat(32)}`],
            data: "0x",
            blockNumber: "0x64",
            blockHash: `0x${"22".repeat(32)}`,
            transactionHash: `0x${"33".repeat(32)}`,
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false
          }
        ]
      : [];
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}) as unknown as typeof fetch;

afterAll(() => {
  global.fetch = realFetch;
});

// No other test imports axios today, so this module mock has no one to leak onto — but it is
// global for the whole run, so anything added later that uses axios must not rely on the real one.
mock.module("axios", () => ({
  default: {
    post: async (url: string, payload: { method: string; params: unknown[] }, config: never) => {
      const headers = (config as unknown as { headers: Record<string, string> }).headers;
      polymerCalls.push({
        url,
        method: payload.method,
        params: payload.params,
        auth: headers.Authorization
      });
      if (payload.method === "polymer_requestProof") {
        return { data: { jsonrpc: "2.0", id: 1, result: 7777 } };
      }
      return { data: { jsonrpc: "2.0", id: 1, result: queryProofResult } };
    }
  }
}));

const { POST } = await import("../../src/routes/polymer/+server");

function post(body: unknown) {
  const request = new Request("https://lintent.org/polymer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  // The handler only touches `request`; the rest of the SvelteKit event is irrelevant here.
  return POST({ request } as unknown as Parameters<typeof POST>[0]);
}

const methods = () => polymerCalls.map((c) => c.method);

beforeEach(() => {
  polymerCalls.length = 0;
  verifyCalls = 0;
  verifyResult = "match";
  queryProofResult = { jobID: 1, createdAt: 0, updatedAt: 0, status: "initialized" };
});

describe("POST /polymer — poll by polymerIndex", () => {
  // Regression: the source-log fields used to be validated unconditionally, so a caller
  // polling an existing job got 400 in ~1ms and never reached Polymer at all.
  it("accepts a bare polymerIndex with no source-log fields", async () => {
    const res = await post({ polymerIndex: 6931827, mainnet: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ polymerIndex: 6931827, status: "initialized" });
  });

  it("queries the existing job instead of opening a new one", async () => {
    await post({ polymerIndex: 6931827 });

    expect(methods()).toEqual(["polymer_queryProof"]);
    expect(polymerCalls[0].params).toEqual([6931827]);
    // No proof request spent, and no RPC round-trip to re-verify the log.
    expect(verifyCalls).toBe(0);
  });

  it("still polls when source-log fields are also supplied", async () => {
    await post({ srcChainId: 8453, srcBlockNumber: 23011456, globalLogIndex: 4, polymerIndex: 42 });

    expect(methods()).toEqual(["polymer_queryProof"]);
    expect(verifyCalls).toBe(0);
  });

  it("hex-encodes a completed proof", async () => {
    queryProofResult = { jobID: 1, createdAt: 0, updatedAt: 0, status: "complete", proof: "q80=" };

    const res = await post({ polymerIndex: 42 });

    expect(await res.json()).toMatchObject({ proof: "abcd", status: "complete" });
  });

  it.each([0, -1, 1.5, "42", Number.MAX_SAFE_INTEGER + 2])(
    "rejects a non-positive-safe-integer polymerIndex: %p",
    async (v) => {
      const res = await post({ polymerIndex: v, srcChainId: 8453 });

      expect(res.status).toBe(400);
      expect(polymerCalls).toHaveLength(0);
    }
  );

  it("treats an explicit null polymerIndex as absent and creates a job", async () => {
    // Serialisers routinely emit null for an unset optional field, so with full coordinates
    // this means "no job yet" rather than "poll job null".
    const res = await post({
      polymerIndex: null,
      srcChainId: 8453,
      srcBlockNumber: 23011456,
      globalLogIndex: 4
    });

    expect(res.status).toBe(200);
    expect(methods()).toEqual(["polymer_requestProof", "polymer_queryProof"]);
  });
});

describe("POST /polymer — request a proof", () => {
  it("verifies the log, requests a proof, then queries it", async () => {
    const res = await post({ srcChainId: 8453, srcBlockNumber: 23011456, globalLogIndex: 4 });

    expect(res.status).toBe(200);
    expect(verifyCalls).toBe(1);
    expect(methods()).toEqual(["polymer_requestProof", "polymer_queryProof"]);
    expect(polymerCalls[0].params).toEqual([
      { srcChainId: 8453, srcBlockNumber: 23011456, globalLogIndex: 4 }
    ]);
    expect(await res.json()).toMatchObject({ polymerIndex: 7777 });
  });

  it("proceeds when verification is inconclusive", async () => {
    verifyResult = "unknown";

    const res = await post({ srcChainId: 8453, srcBlockNumber: 23011456, globalLogIndex: 4 });

    expect(res.status).toBe(200);
    expect(methods()).toEqual(["polymer_requestProof", "polymer_queryProof"]);
  });

  it("spends no proof request when the log is not an allowlisted event", async () => {
    verifyResult = "mismatch";

    const res = await post({ srcChainId: 8453, srcBlockNumber: 23011456, globalLogIndex: 4 });

    expect(res.status).toBe(400);
    expect(polymerCalls).toHaveLength(0);
  });

  it.each([
    ["srcChainId", { srcBlockNumber: 23011456, globalLogIndex: 4 }],
    ["srcBlockNumber", { srcChainId: 8453, globalLogIndex: 4 }],
    ["globalLogIndex", { srcChainId: 8453, srcBlockNumber: 23011456 }]
  ])("rejects a request missing %s", async (_field, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(verifyCalls).toBe(0);
    expect(polymerCalls).toHaveLength(0);
  });

  it("accepts globalLogIndex 0", async () => {
    const res = await post({ srcChainId: 8453, srcBlockNumber: 23011456, globalLogIndex: 0 });

    expect(res.status).toBe(200);
  });

  // Already rounded by JSON.parse, so the proof would be minted for coordinates other than the
  // ones the caller actually sent. Every numeric field needs the bound, not just the block.
  it.each([
    [
      "srcChainId",
      { srcChainId: Number.MAX_SAFE_INTEGER + 2, srcBlockNumber: 23011456, globalLogIndex: 4 }
    ],
    [
      "srcBlockNumber",
      { srcChainId: 8453, srcBlockNumber: Number.MAX_SAFE_INTEGER + 2, globalLogIndex: 4 }
    ],
    [
      "globalLogIndex",
      { srcChainId: 8453, srcBlockNumber: 23011456, globalLogIndex: Number.MAX_SAFE_INTEGER + 2 }
    ]
  ])("rejects an unsafe-integer %s", async (_field, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(verifyCalls).toBe(0);
    expect(polymerCalls).toHaveLength(0);
  });

  it.each([null, "[]", '"str"', "42"])("rejects a non-object JSON body: %p", async (raw) => {
    const request = new Request("https://lintent.org/polymer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw === null ? "null" : raw
    });
    const res = await POST({ request } as unknown as Parameters<typeof POST>[0]);

    // `null` used to destructure-throw into a framework 500 instead of a controlled 400.
    expect(res.status).toBe(400);
    expect(polymerCalls).toHaveLength(0);
  });

  it("rejects a malformed JSON body", async () => {
    const request = new Request("https://lintent.org/polymer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });
    const res = await POST({ request } as unknown as Parameters<typeof POST>[0]);

    expect(res.status).toBe(400);
    expect(polymerCalls).toHaveLength(0);
  });
});

describe("POST /polymer — network selection", () => {
  it("defaults to mainnet", async () => {
    await post({ polymerIndex: 42 });

    expect(polymerCalls[0].url).toBe("https://api.polymer.zone/v1/");
    expect(polymerCalls[0].auth).toBe("Bearer mainnet-key");
  });

  it("uses the testnet endpoint and key when mainnet is false", async () => {
    await post({ polymerIndex: 42, mainnet: false });

    expect(polymerCalls[0].url).toBe("https://api.testnet.polymer.zone/v1/");
    expect(polymerCalls[0].auth).toBe("Bearer testnet-key");
  });

  // Wrapped in objects because bun's `it.each` spreads a bare array row into separate args,
  // which would turn the `[]` case into "no argument at all".
  it.each([
    { label: '"false"', value: "false" },
    { label: "1", value: 1 },
    { label: "0", value: 0 },
    { label: "{}", value: {} },
    { label: "[]", value: [] }
  ])("rejects a non-boolean mainnet: $label", async ({ value }) => {
    // Under truthiness `"false"` and `1` would have selected mainnet and `0` testnet, spending
    // the wrong environment's key.
    const res = await post({ polymerIndex: 42, mainnet: value });

    expect(res.status).toBe(400);
    expect(polymerCalls).toHaveLength(0);
  });
});
