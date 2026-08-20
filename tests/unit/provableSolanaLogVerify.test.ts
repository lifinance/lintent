import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { SOLANA_DEVNET_CHAIN_ID, SOLANA_MAINNET_CHAIN_ID } from "@lifi/intent";

// `$env/static/private` is a Vite virtual module with no file behind it, so the real one can
// never resolve under `bun test`. Stub it before importing the module under test.
mock.module("$env/static/private", () => ({
  PRIVATE_POLYMER_MAINNET_ZONE_API_KEY: "mainnet-key",
  PRIVATE_POLYMER_TESTNET_ZONE_API_KEY: "testnet-key",
  PRIVATE_ROUTEMESH_API_KEY: "routemesh-key"
}));

// PRIVATE_SOLANA_RPC_URL is optional, so it is read through `$env/dynamic/private`
// — the static form would fail the import outright when the key is absent.
// Left empty here so the public-endpoint fallback is what gets exercised.
mock.module("$env/dynamic/private", () => ({ env: {} }));

type Verify =
  typeof import("../../src/lib/libraries/provableSolanaLogVerify").verifyProvableSolanaLog;

let verifyProvableSolanaLog: Verify;
let POLYMER_SOLANA_PROGRAM_ID: string;

type RpcCall = { url: string; method: string; params: unknown[] };

const calls: RpcCall[] = [];
let reply: (call: RpcCall) => Response;
const realFetch = global.fetch;

const SIGNATURE = "5".repeat(87);

beforeAll(async () => {
  global.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push({ url: String(url), method: body.method, params: body.params });
    return reply(calls[calls.length - 1]);
  }) as unknown as typeof fetch;

  ({ verifyProvableSolanaLog, POLYMER_SOLANA_PROGRAM_ID } = await import(
    "../../src/lib/libraries/provableSolanaLogVerify"
  ));
});

// bun runs every test file in one process, so an unrestored stub would silently serve the next
// file that happens to use fetch.
afterAll(() => {
  global.fetch = realFetch;
});

beforeEach(() => {
  calls.length = 0;
});

/** A getTransaction result carrying the given program logs. */
function rpcOk(logMessages: string[] | null, result: "present" | "null" = "present") {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: result === "null" ? null : { meta: { logMessages } }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/** The literal line `oracle_polymer::submit` emits: `Prove: program: {id}, {base64}`. */
function proveLog(programId: string) {
  return `Program log: Prove: program: ${programId}, YWJjZA==`;
}

describe("verifyProvableSolanaLog", () => {
  it("asks the RPC for the transaction with a version-tolerant getTransaction", async () => {
    reply = () => rpcOk([proveLog(POLYMER_SOLANA_PROGRAM_ID)]);
    await verifyProvableSolanaLog(Number(SOLANA_MAINNET_CHAIN_ID), SIGNATURE, "prog");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("getTransaction");
    expect(calls[0].params[0]).toBe(SIGNATURE);
    // Without maxSupportedTransactionVersion the RPC errors on every v0 transaction, which is
    // most of them — the gate would then be permanently inconclusive.
    expect(calls[0].params[1]).toMatchObject({ maxSupportedTransactionVersion: 0 });
  });

  it("matches the Prove log of the pinned program", async () => {
    reply = () =>
      rpcOk([
        "Program LiFiBtfyPT1DnTHTAeZ2rwr5RgMrThwA5kt7KGT5nBV invoke [1]",
        proveLog(POLYMER_SOLANA_PROGRAM_ID),
        "Program LiFiBtfyPT1DnTHTAeZ2rwr5RgMrThwA5kt7KGT5nBV success"
      ]);

    expect(
      await verifyProvableSolanaLog(
        Number(SOLANA_MAINNET_CHAIN_ID),
        SIGNATURE,
        POLYMER_SOLANA_PROGRAM_ID
      )
    ).toBe("match");
  });

  it("rejects a Prove log emitted by a different program", async () => {
    // The whole point of carrying the program id into the marker: Polymer keys attestations by
    // `returnedProgramId`, so another program's Prove log must not pass as ours.
    reply = () => rpcOk([proveLog("11111111111111111111111111111111")]);

    expect(
      await verifyProvableSolanaLog(
        Number(SOLANA_MAINNET_CHAIN_ID),
        SIGNATURE,
        POLYMER_SOLANA_PROGRAM_ID
      )
    ).toBe("mismatch");
  });

  it("rejects a transaction with no Prove log at all", async () => {
    reply = () => rpcOk(["Program log: Instruction: Fill", "Program log: success"]);

    expect(
      await verifyProvableSolanaLog(
        Number(SOLANA_MAINNET_CHAIN_ID),
        SIGNATURE,
        POLYMER_SOLANA_PROGRAM_ID
      )
    ).toBe("mismatch");
  });

  it.each([
    ["a null result (not indexed yet)", () => rpcOk(null, "null")],
    ["missing logMessages", () => rpcOk(null)],
    [
      "a JSON-RPC error",
      () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "boom" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    ],
    ["a non-200 response", () => new Response("nope", { status: 503 })],
    [
      "a thrown transport error",
      () => {
        throw new Error("rpc down");
      }
    ]
  ])("degrades to unknown on %s", async (_label, r) => {
    // Deliberately fail-open (the route only rejects "mismatch"), so an infra blip does not block
    // the happy path. Pinned so the trade-off is a decision, not an accident.
    reply = r as (call: RpcCall) => Response;

    expect(
      await verifyProvableSolanaLog(
        Number(SOLANA_MAINNET_CHAIN_ID),
        SIGNATURE,
        POLYMER_SOLANA_PROGRAM_ID
      )
    ).toBe("unknown");
  });

  it("picks the public endpoint matching the network when no private RPC is configured", async () => {
    reply = () => rpcOk([]);

    await verifyProvableSolanaLog(Number(SOLANA_MAINNET_CHAIN_ID), SIGNATURE, "prog");
    await verifyProvableSolanaLog(Number(SOLANA_DEVNET_CHAIN_ID), SIGNATURE, "prog");

    expect(calls[0].url).toBe("https://api.mainnet-beta.solana.com");
    expect(calls[1].url).toBe("https://api.devnet.solana.com");
  });
});
