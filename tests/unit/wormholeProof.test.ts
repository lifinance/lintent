import { afterEach, describe, expect, test } from "bun:test";
import { base64 } from "@scure/base";
import { createVAA, serialize, UniversalAddress } from "@wormhole-foundation/sdk-definitions";
import { encodeFillDescription, encodeNotFilledDescription, addressToBytes32 } from "@lifi/intent";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { WORMHOLE_ORACLE } from "../../src/lib/config";
import {
  assertWormholeVaa,
  decodeWormholeEnvelope,
  getSignedWormholeVaa,
  pollWormholeVaa,
  type WormholePublication
} from "../../src/lib/libraries/wormholeProof";
import { b32, makeMandateOutput, TEST_NOW_SECONDS } from "../fixtures/orderFixtures";

const output = makeMandateOutput(8453n, 123n, { oracle: addressToBytes32(WORMHOLE_ORACLE[8453]!) });
const orderId = b32("a");
const solver = b32("b");
const payload = encodeFillDescription({ orderId, output, solver, timestamp: TEST_NOW_SECONDS });
const application = output.settler.toLowerCase() as Hex;
const publication: WormholePublication = {
  id: {
    network: "mainnet",
    emitterChain: 30,
    emitter: output.oracle,
    sequence: "9007199254740993"
  },
  nonce: 0,
  consistencyLevel: 15
};

function envelope(payloads: Hex[], app = application): Uint8Array {
  const parts = payloads.map((payload) => hexToBytes(payload));
  const bytes = new Uint8Array(34 + parts.reduce((sum, p) => sum + 2 + p.length, 0));
  bytes.set(hexToBytes(app));
  const view = new DataView(bytes.buffer);
  view.setUint16(32, parts.length);
  let offset = 34;
  for (const part of parts) {
    view.setUint16(offset, part.length);
    offset += 2;
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
function vaa(body = envelope([payload]), changes: Record<string, unknown> = {}): Uint8Array {
  return serialize(
    createVAA("Uint8Array", {
      guardianSet: 0,
      signatures: [],
      timestamp: TEST_NOW_SECONDS,
      nonce: 0,
      emitterChain: "Base",
      emitterAddress: new UniversalAddress(hexToBytes(output.oracle)),
      sequence: BigInt(publication.id.sequence),
      consistencyLevel: 15,
      payload: body,
      ...changes
    })
  );
}
const fetchOriginal = globalThis.fetch;
function stubFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): typeof fetch {
  return Object.assign(handler, { preconnect: fetchOriginal.preconnect });
}
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe("bound Wormhole VAA", () => {
  test("preserves uint64 sequence and every batch payload in order", () => {
    const other = encodeNotFilledDescription({ orderId, output, fillDeadline: TEST_NOW_SECONDS });
    const decoded = assertWormholeVaa(vaa(envelope([other, payload])), publication, {
      application,
      payload
    });
    expect(decoded.sequence).toBe(9007199254740993n);
    expect(decodeWormholeEnvelope(decoded.payload)).toEqual({
      application,
      payloads: [other, payload]
    });
  });
  test.each([
    ["chain", { emitterChain: "Arbitrum" }],
    ["emitter", { emitterAddress: new UniversalAddress(hexToBytes(b32("c"))) }],
    ["sequence", { sequence: 9007199254740992n }],
    ["nonce", { nonce: 1 }],
    ["consistency", { consistencyLevel: 1 }]
  ])("rejects wrong %s", (_label, changes) => {
    expect(() =>
      assertWormholeVaa(vaa(undefined, changes as Record<string, unknown>), publication, {
        application,
        payload
      })
    ).toThrow("identity");
  });
  test("rejects application and exact solver/timestamp/output mutations", () => {
    expect(() =>
      assertWormholeVaa(vaa(envelope([payload], b32("d"))), publication, { application, payload })
    ).toThrow("exact expected");
    for (const changed of [
      encodeFillDescription({ orderId, output, solver: b32("c"), timestamp: TEST_NOW_SECONDS }),
      encodeFillDescription({ orderId, output, solver, timestamp: TEST_NOW_SECONDS + 1 }),
      encodeFillDescription({
        orderId,
        output: { ...output, amount: 124n },
        solver,
        timestamp: TEST_NOW_SECONDS
      }),
      encodeFillDescription({
        orderId,
        output: { ...output, recipient: b32("c") },
        solver,
        timestamp: TEST_NOW_SECONDS
      }),
      encodeFillDescription({
        orderId,
        output: { ...output, context: "0x01" },
        solver,
        timestamp: TEST_NOW_SECONDS
      })
    ])
      expect(() =>
        assertWormholeVaa(vaa(envelope([changed])), publication, { application, payload })
      ).toThrow("exact expected");
  });
  test("rejects fabricated non-fill deadline", () => {
    const signed = encodeNotFilledDescription({ orderId, output, fillDeadline: TEST_NOW_SECONDS });
    const fabricated = encodeNotFilledDescription({
      orderId,
      output,
      fillDeadline: TEST_NOW_SECONDS - 1
    });
    expect(() =>
      assertWormholeVaa(vaa(envelope([fabricated])), publication, { application, payload: signed })
    ).toThrow("exact expected");
  });
  test("rejects legacy untagged payload even if exact bytes match", () => {
    const legacy = `0x${payload.slice(10)}` as Hex;
    expect(() =>
      assertWormholeVaa(vaa(envelope([legacy])), publication, { application, payload: legacy })
    ).toThrow("current tagged");
  });
  test("rejects descending and duplicate guardian indexes", () => {
    const unsigned = vaa();
    for (const indexes of [
      [1, 0],
      [0, 0]
    ]) {
      const bytes = new Uint8Array(unsigned.length + 132);
      bytes.set(unsigned.subarray(0, 6));
      bytes[5] = 2;
      bytes[6] = indexes[0];
      bytes[72] = indexes[1];
      bytes.set(unsigned.subarray(6), 138);
      expect(() => assertWormholeVaa(bytes, publication, { application, payload })).toThrow(
        "ascending"
      );
    }
  });
  test("rejects malformed envelope count, lengths and trailing bytes", () => {
    const valid = envelope([payload]);
    const empty = new Uint8Array(36);
    const truncLength = valid.subarray(0, 35);
    const truncPayload = valid.subarray(0, valid.length - 1);
    const trailing = new Uint8Array(valid.length + 1);
    trailing.set(valid);
    const wrongCount = valid.slice();
    wrongCount[33] = 2;
    for (const bytes of [empty, truncLength, truncPayload, trailing, wrongCount])
      expect(() => decodeWormholeEnvelope(bytes)).toThrow();
  });
});

describe("Wormhole Scan transport", () => {
  test("404 and absent signed VAA are pending, not a failed proof", async () => {
    for (const response of [
      new Response(null, { status: 404 }),
      Response.json({}),
      Response.json({ vaaBytes: null })
    ]) {
      globalThis.fetch = stubFetch(async () => response);
      expect(await getSignedWormholeVaa(publication.id)).toEqual({ status: "pending" });
    }
  });
  test("404 then signed VAA resumes the same publication", async () => {
    const urls: string[] = [];
    globalThis.fetch = stubFetch(async (input) => {
      urls.push(String(input));
      return urls.length === 1
        ? new Response(null, { status: 404 })
        : Response.json({ vaaBytes: base64.encode(vaa()) });
    });
    const result = await pollWormholeVaa(publication, { application, payload });
    expect(result).toEqual({ status: "proof", proof: bytesToHex(vaa()) });
    expect(urls).toEqual([urls[0], urls[0]]);
    expect(urls[0]).toEndWith("/9007199254740993");
  });
  test("uses source network and decimal uint64 without numeric conversion", async () => {
    let requested = "";
    globalThis.fetch = stubFetch(async (input) => {
      requested = String(input);
      return Response.json({ vaaBytes: base64.encode(vaa()) });
    });
    const result = await getSignedWormholeVaa({ ...publication.id, network: "testnet" });
    expect(requested).toBe(
      `https://api.testnet.wormholescan.io/v1/signed_vaa/30/${output.oracle.slice(2)}/9007199254740993`
    );
    expect(result.status).toBe("vaa");
    if (result.status === "vaa") expect(bytesToHex(result.bytes)).toBe(bytesToHex(vaa()));
  });
  test("transport failures retain the message identity and cannot become proof", async () => {
    for (const status of [429, 500]) {
      globalThis.fetch = stubFetch(async () => new Response(null, { status }));
      await expect(pollWormholeVaa(publication, { application, payload })).rejects.toThrow(
        "Retry to resume the same message"
      );
    }
    globalThis.fetch = stubFetch(async () => {
      throw new Error("network");
    });
    await expect(getSignedWormholeVaa(publication.id)).rejects.toThrow(
      "Retry to resume the same message"
    );
    expect(publication.id.sequence).toBe("9007199254740993");
  });
  test("malformed Base64, JSON and VAA headers are permanent errors", async () => {
    for (const response of [
      Response.json({ vaaBytes: "%%%" }),
      Response.json({ vaaBytes: base64.encode(new Uint8Array([1, 2, 3])) }),
      new Response("invalid", { status: 200 })
    ]) {
      globalThis.fetch = stubFetch(async () => response);
      await expect(getSignedWormholeVaa(publication.id)).rejects.toThrow("Malformed");
    }
  });
  test("poll never returns a proof for a mismatched exact payload", async () => {
    globalThis.fetch = stubFetch(async () =>
      Response.json({
        vaaBytes: base64.encode(
          vaa(
            envelope([
              encodeNotFilledDescription({ orderId, output, fillDeadline: TEST_NOW_SECONDS })
            ])
          )
        )
      })
    );
    await expect(pollWormholeVaa(publication, { application, payload })).rejects.toThrow(
      "exact expected"
    );
  });
});
