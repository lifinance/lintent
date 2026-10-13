import { base64 } from "@scure/base";
import { toChainId } from "@wormhole-foundation/sdk-base";
import { deserialize, type VAA } from "@wormhole-foundation/sdk-definitions";
import { bytesToHex, type Hex } from "viem";
import type { TxRef } from "$lib/utils/txRef";

export type WormholeMessageId = {
  network: "mainnet" | "testnet";
  emitterChain: number;
  emitter: Hex;
  sequence: string;
};
export type WormholeExpectedMessage = { application: Hex; payload: Hex };
export type WormholePublication = {
  id: WormholeMessageId;
  nonce: number;
  consistencyLevel: number;
  txRef?: TxRef;
  messageAccount?: string;
};

const SCAN_ROOTS = {
  mainnet: "https://api.wormholescan.io",
  testnet: "https://api.testnet.wormholescan.io"
} as const;
const WAITS_MS = [2000, 3000, 5000, 8000, 13000, 20000] as const;
const TRANSPORT_ERROR = "Couldn't reach Wormhole Scan. Retry to resume the same message.";
const BYTES32 = /^0x[0-9a-f]{64}$/i;
const TAGS: Record<string, true> = { "0xd1252dff": true, "0x830c1e1c": true };

export function assertWormholeMessageId(id: WormholeMessageId): void {
  if (
    !(id.network === "mainnet" || id.network === "testnet") ||
    !Number.isInteger(id.emitterChain) ||
    id.emitterChain <= 0 ||
    id.emitterChain > 65535 ||
    !BYTES32.test(id.emitter) ||
    !/^(0|[1-9][0-9]*)$/.test(id.sequence) ||
    BigInt(id.sequence) > 0xffffffffffffffffn
  ) {
    throw new Error("Invalid Wormhole message identity.");
  }
}

/** Bounded protocol envelope decoding, with no ignored trailing bytes. */
export function decodeWormholeEnvelope(bytes: Uint8Array): { application: Hex; payloads: Hex[] } {
  if (bytes.length < 36) throw new Error("Truncated Wormhole envelope.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(32, false);
  if (count === 0) throw new Error("Wormhole envelope must contain a payload.");
  const payloads: Hex[] = [];
  let offset = 34;
  for (let i = 0; i < count; i++) {
    if (offset + 2 > bytes.length) throw new Error("Truncated Wormhole payload length.");
    const length = view.getUint16(offset, false);
    offset += 2;
    if (offset + length > bytes.length) throw new Error("Truncated Wormhole payload.");
    payloads.push(bytesToHex(bytes.subarray(offset, offset + length)));
    offset += length;
  }
  if (offset !== bytes.length) throw new Error("Trailing bytes in Wormhole envelope.");
  return { application: bytesToHex(bytes.subarray(0, 32)), payloads };
}

/** Structural binding only: guardian verification is performed by the receiving Core/oracle. */
export function assertWormholeVaa(
  bytes: Uint8Array,
  publication: WormholePublication,
  expected: WormholeExpectedMessage
): VAA<"Uint8Array"> {
  assertWormholeMessageId(publication.id);
  if (
    !BYTES32.test(expected.application) ||
    !/^0x(?:[0-9a-f]{2})+$/i.test(expected.payload) ||
    !TAGS[expected.payload.slice(0, 10).toLowerCase()]
  ) {
    throw new Error("Expected a current tagged OIF fill or non-fill payload.");
  }
  const vaa = deserialize("Uint8Array", bytes);
  const id = publication.id;
  if (
    toChainId(vaa.emitterChain) !== id.emitterChain ||
    bytesToHex(vaa.emitterAddress.toUint8Array()).toLowerCase() !== id.emitter.toLowerCase() ||
    vaa.sequence !== BigInt(id.sequence) ||
    vaa.nonce !== publication.nonce ||
    vaa.consistencyLevel !== publication.consistencyLevel
  ) {
    throw new Error("Wormhole VAA does not match the published message identity.");
  }
  const envelope = decodeWormholeEnvelope(vaa.payload);
  if (
    envelope.application.toLowerCase() !== expected.application.toLowerCase() ||
    !envelope.payloads.some((payload) => payload.toLowerCase() === expected.payload.toLowerCase())
  ) {
    throw new Error("Wormhole VAA does not contain the exact expected application and payload.");
  }
  return vaa;
}

export async function getSignedWormholeVaa(
  id: WormholeMessageId
): Promise<{ status: "pending" } | { status: "vaa"; bytes: Uint8Array }> {
  assertWormholeMessageId(id);
  let response: Response;
  try {
    response = await fetch(
      `${SCAN_ROOTS[id.network]}/v1/signed_vaa/${id.emitterChain}/${id.emitter.slice(2).toLowerCase()}/${id.sequence}`,
      {
        signal: AbortSignal.timeout(15000)
      }
    );
  } catch (cause) {
    throw new Error(TRANSPORT_ERROR, { cause });
  }
  if (response.status === 404) return { status: "pending" };
  if (!response.ok) throw new Error(TRANSPORT_ERROR);
  let data: { vaaBytes?: unknown };
  try {
    data = await response.json();
  } catch (cause) {
    throw new Error(
      cause instanceof SyntaxError ? "Malformed Wormhole Scan VAA response." : TRANSPORT_ERROR,
      { cause }
    );
  }
  if (!data || typeof data !== "object") throw new Error("Malformed Wormhole Scan VAA response.");
  if (data.vaaBytes === undefined || data.vaaBytes === null || data.vaaBytes === "")
    return { status: "pending" };
  if (typeof data.vaaBytes !== "string") throw new Error("Malformed Wormhole Scan VAA Base64.");
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(data.vaaBytes);
    if (base64.encode(bytes) !== data.vaaBytes) throw new Error("Noncanonical Base64");
    deserialize("Uint8Array", bytes);
  } catch (cause) {
    throw new Error("Malformed Wormhole Scan VAA.", { cause });
  }
  return { status: "vaa", bytes };
}

export async function pollWormholeVaa(
  publication: WormholePublication,
  expected: WormholeExpectedMessage,
  opts?: { onProgress?: (attempt: number, total: number) => void }
): Promise<{ status: "pending" } | { status: "proof"; proof: Hex }> {
  for (let attempt = 0; attempt <= WAITS_MS.length; attempt++) {
    opts?.onProgress?.(attempt + 1, WAITS_MS.length + 1);
    const result = await getSignedWormholeVaa(publication.id);
    if (result.status === "vaa") {
      assertWormholeVaa(result.bytes, publication, expected);
      return { status: "proof", proof: bytesToHex(result.bytes) };
    }
    if (attempt < WAITS_MS.length)
      await new Promise<void>((resolve) => setTimeout(resolve, WAITS_MS[attempt]));
  }
  return { status: "pending" };
}

export {
  publishEvmWormhole,
  findWormholePublication,
  verifyWormholePublication,
  loadWormholeHint,
  saveWormholeHint,
  saveWormholeMessageAccount,
  clearWormholeHint
} from "./wormholePublication";
