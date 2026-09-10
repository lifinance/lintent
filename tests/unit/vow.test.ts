import { describe, expect, it } from "bun:test";
import { compactSignatureToSignature, parseCompactSignature, serializeSignature } from "viem";
import {
  encodeVowEvent,
  pollVowWitness,
  validateAndEncodeVow,
  type VowFillLog
} from "../../src/lib/libraries/vow";
import { LIVE_VOW_WITNESS as witness, REFERENCE_VOW_HEX } from "../fixtures/vowWitness";

const log: VowFillLog = {
  ...witness.event,
  chainId: 1n,
  blockNumber: BigInt(witness.rootBlockNumber),
  blockHash: witness.blockHash,
  logIndex: 4
};

describe("Vow EVM witness", () => {
  it("matches the live protocol reference byte for byte with a compact signature", async () => {
    expect(await validateAndEncodeVow(witness, log, 1)).toBe(REFERENCE_VOW_HEX);
  });
  it("supports 65-byte signatures", async () => {
    const signature = serializeSignature(
      compactSignatureToSignature(parseCompactSignature(witness.signature))
    );
    const encoded = await validateAndEncodeVow({ ...witness, signature }, log, 1);
    expect(encoded).toContain(`010041${signature.slice(2)}`);
  });
  it("rejects mismatched chain, block, block hash and event", async () => {
    for (const expected of [
      { ...log, chainId: 8453n },
      { ...log, blockNumber: log.blockNumber + 1n },
      { ...log, blockHash: `0x${"00".repeat(32)}` as const },
      { ...log, data: "0x" as const }
    ])
      await expect(validateAndEncodeVow(witness, expected, 1)).rejects.toThrow("mismatch");
  });
  it("rejects altered roots, proofs and signers", async () => {
    const zero = `0x${"00".repeat(32)}` as const;
    await expect(validateAndEncodeVow({ ...witness, root: zero }, log, 1)).rejects.toThrow(
      "Merkle"
    );
    await expect(validateAndEncodeVow({ ...witness, proof: [zero] }, log, 1)).rejects.toThrow(
      "Merkle"
    );
    await expect(validateAndEncodeVow({ ...witness, signer: log.emitter }, log, 1)).rejects.toThrow(
      "signer mismatch"
    );
  });
  it("checks packed field limits and malformed payloads", async () => {
    for (const signerIndex of [0, -1, 256, 1.5])
      await expect(validateAndEncodeVow(witness, log, signerIndex)).rejects.toThrow("signer index");
    await expect(validateAndEncodeVow({ ...witness, signature: "0x12" }, log, 1)).rejects.toThrow(
      "signature length"
    );
    await expect(
      validateAndEncodeVow({ ...witness, proof: Array(256).fill(witness.root) }, log, 1)
    ).rejects.toThrow("proof length");
    expect(() => encodeVowEvent({ ...witness.event, topics: Array(5).fill(witness.root) })).toThrow(
      "topics"
    );
    expect(() => encodeVowEvent({ ...witness.event, data: "0x1" })).toThrow("hex");
  });
});

describe("Vow polling", () => {
  it("polls indexing, pending and transient failures before returning a witness", async () => {
    const responses = [
      new Error("offline"),
      new Response(null, { status: 429 }),
      new Response(null, { status: 503 }),
      Response.json({ status: "indexing" }),
      Response.json({ status: "pending" }),
      Response.json({ status: "ready", witness, signerIndex: 1 })
    ];
    const requests: { blockNumber: string; logIndex: number; chainId: number }[] = [];
    const fakeFetch = Object.assign(
      async (_input: unknown, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        const next = responses.shift();
        if (next instanceof Error) throw next;
        if (!next) throw new Error("unexpected request");
        return next;
      },
      { preconnect: fetch.preconnect }
    );
    expect(await pollVowWitness(log, { fetch: fakeFetch, intervalMs: 0, timeoutMs: 1000 })).toEqual(
      { witness, signerIndex: 1 }
    );
    expect(requests).toHaveLength(6);
    expect(requests[0]).toEqual({ chainId: 1, blockNumber: String(log.blockNumber), logIndex: 4 });
  });
  it("surfaces permanent failures and malformed ready responses", async () => {
    for (const response of [
      Response.json({ error: "rejected" }, { status: 401 }),
      Response.json({ status: "failed", error: "rejected" }),
      Response.json({ status: "ready" })
    ]) {
      const fakeFetch = Object.assign(async () => response, { preconnect: fetch.preconnect });
      await expect(pollVowWitness(log, { fetch: fakeFetch })).rejects.toThrow();
    }
  });
  it("stops at its deadline with a retry message", async () => {
    const fakeFetch = Object.assign(async () => Response.json({ status: "pending" }), {
      preconnect: fetch.preconnect
    });
    await expect(
      pollVowWitness(log, { fetch: fakeFetch, timeoutMs: 10, intervalMs: 1 })
    ).rejects.toThrow("Retry");
  });
});
