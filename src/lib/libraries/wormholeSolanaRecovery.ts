import { base58, base64 } from "@scure/base";
import {
  encodeFillDescription,
  encodeNotFilledDescription,
  getNotFilledDescriptionHash
} from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import { toChainId } from "@wormhole-foundation/sdk-base";
import { deserialize } from "@wormhole-foundation/sdk-definitions";
import { Connection, PublicKey } from "@solana/web3.js";
import type { AccountInfo, VersionedTransactionResponse } from "@solana/web3.js";
import { bytesToHex, hexToBytes } from "viem";
import type { Hex } from "viem";
import {
  SOLANA_OUTPUT_SETTLER,
  SOLANA_WORMHOLE_CORE,
  WORMHOLE_CHAIN_IDS,
  WORMHOLE_ORACLE
} from "$lib/config";
import { WORMHOLE_PROGRAM_ID } from "$lib/idl";
import { SOLANA_GENESIS_HASHES, solanaRpcUrl } from "$lib/solana/client";
import { localAttestationDataHash } from "$lib/solana/encode";
import { classifyLocalAttestation } from "$lib/solana/nonFill";
import { bytes32ToPubkey, localAttestationPda, outputSettlerSimplePda } from "$lib/solana/pda";
import { isValidTxRef } from "$lib/utils/txRef";
import { assertWormholeVaa, decodeWormholeEnvelope, getSignedWormholeVaa } from "./wormholeProof";
import type { WormholeExpectedMessage, WormholePublication } from "./wormholeProof";

const STATE_DISCRIMINATOR = "0xdacfeebe62a303c7";
const HISTORY_UNAVAILABLE =
  "Wormhole publication history unavailable. Retry with an archival RPC or the publication transaction.";
const SCAN_ROOT = "https://api.wormholescan.io";

type TaggedProof = {
  timestamp: number;
  localHash: Hex;
  kind: "fill" | "non-fill";
};
type RecoveryConnection = {
  connection: Connection;
  core: PublicKey;
  emitter: PublicKey;
  nativeId: number;
};

/** Read the maintained SDK's packed layout, then round-trip through its encoder. */
function taggedProof(output: MandateOutput, expected: WormholeExpectedMessage): TaggedProof {
  if (expected.application.toLowerCase() !== output.settler.toLowerCase()) {
    throw new Error("Wormhole application does not match the output settler.");
  }
  const bytes = hexToBytes(expected.payload);
  const tag = bytesToHex(bytes.subarray(0, 4));
  const fill = tag === "0xd1252dff";
  if ((!fill && tag !== "0x830c1e1c") || bytes.length < (fill ? 172 : 140)) {
    throw new Error("Expected a current tagged OIF fill or non-fill payload.");
  }
  const timestampOffset = fill ? 68 : 36;
  const timestamp = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    timestampOffset,
    false
  );
  const orderId = bytesToHex(bytes.subarray(fill ? 36 : 4, fill ? 68 : 36));
  const solver = bytesToHex(bytes.subarray(4, 36));
  const args = { orderId, output, fillDeadline: timestamp };
  const encoded = fill
    ? encodeFillDescription({ orderId, output, solver, timestamp })
    : encodeNotFilledDescription(args);
  if (encoded.toLowerCase() !== expected.payload.toLowerCase()) {
    throw new Error("Wormhole payload does not match the exact signed output.");
  }
  return {
    timestamp,
    kind: fill ? "fill" : "non-fill",
    localHash: fill
      ? localAttestationDataHash({ orderId, output, solver })
      : getNotFilledDescriptionHash(args)
  };
}

function matchesEnvelope(bytes: Uint8Array, expected: WormholeExpectedMessage): boolean {
  const envelope = decodeWormholeEnvelope(bytes);
  return (
    envelope.application.toLowerCase() === expected.application.toLowerCase() &&
    envelope.payloads.some((payload) => payload.toLowerCase() === expected.payload.toLowerCase())
  );
}

/** Same message-account conventions as SDK SolanaWormholeCore.parseMessages;
 * unlike parseTransaction, this never chooses a Sequence log. */
async function messageAccounts(
  connection: Connection,
  tx: VersionedTransactionResponse,
  core: PublicKey
): Promise<PublicKey[]> {
  const message = tx.transaction.message;
  let keys;
  if (message.version === "legacy") {
    keys = message.getAccountKeys();
  } else if (tx.meta?.loadedAddresses) {
    keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  } else {
    const tables = await Promise.all(
      message.addressTableLookups.map(async (lookup) => {
        const result = await connection.getAddressLookupTable(lookup.accountKey);
        if (!result.value) throw new Error(HISTORY_UNAVAILABLE);
        return result.value;
      })
    );
    keys = message.getAccountKeys({ addressLookupTableAccounts: tables });
  }
  const accounts: PublicKey[] = [];
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (!keys.get(ix.programIdIndex)?.equals(core)) continue;
      // Core PostMessage (1) and PostMessageUnreliable (8), not fee/verify instructions.
      const data = base58.decode(ix.data);
      if (data[0] !== 1 && data[0] !== 8) continue;
      const account = keys.get(ix.accounts[1]);
      if (!account) throw new Error(HISTORY_UNAVAILABLE);
      if (!accounts.some((existing) => existing.equals(account))) accounts.push(account);
    }
  }
  return accounts;
}

/** Scan is a recovery index, not guardian verification or proof of delivery. */
async function scanHistory(
  output: MandateOutput,
  expected: WormholeExpectedMessage,
  timestamp: number
): Promise<WormholePublication[]> {
  const nativeId = WORMHOLE_CHAIN_IDS[Number(output.chainId)]!;
  const emitter = bytesToHex(hexToBytes(output.oracle));
  const candidates: WormholePublication[] = [];
  for (let page = 0; ; page++) {
    const response = await fetch(
      `${SCAN_ROOT}/api/v1/vaas/${nativeId}/${emitter.slice(2)}?page=${page}&pageSize=20&sortOrder=DESC`,
      {
        signal: AbortSignal.timeout(15000)
      }
    );
    if (!response.ok) throw new Error(HISTORY_UNAVAILABLE);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
      throw new Error(HISTORY_UNAVAILABLE);
    }
    if (body.data.length === 0) return candidates;
    let crossedTimestamp = false;
    for (const entry of body.data) {
      if (!entry || typeof entry !== "object" || typeof entry.vaa !== "string")
        throw new Error(HISTORY_UNAVAILABLE);
      const bytes = base64.decode(entry.vaa);
      if (base64.encode(bytes) !== entry.vaa) throw new Error(HISTORY_UNAVAILABLE);
      const vaa = deserialize("Uint8Array", bytes);
      if (
        toChainId(vaa.emitterChain) !== nativeId ||
        bytesToHex(vaa.emitterAddress.toUint8Array()).toLowerCase() !== emitter ||
        vaa.nonce !== 0 ||
        vaa.signatures.length === 0
      ) {
        throw new Error(HISTORY_UNAVAILABLE);
      }
      if (vaa.timestamp < timestamp) {
        crossedTimestamp = true;
        continue;
      }
      let matches = false;
      try {
        matches = matchesEnvelope(vaa.payload, expected);
      } catch {
        /* unrelated oracle message */
      }
      if (!matches) continue;
      const publication: WormholePublication = {
        id: {
          network: "mainnet",
          emitterChain: nativeId,
          emitter,
          sequence: vaa.sequence.toString()
        },
        nonce: vaa.nonce,
        consistencyLevel: vaa.consistencyLevel,
        ...(isValidTxRef(entry.txHash, output.chainId) ? { txRef: entry.txHash } : {})
      };
      assertWormholeVaa(bytes, publication, expected);
      candidates.push(publication);
    }
    if (crossedTimestamp || body.data.length < 20) return candidates;
  }
}

async function recoveryConnection(output: MandateOutput): Promise<RecoveryConnection> {
  const nativeId = WORMHOLE_CHAIN_IDS[Number(output.chainId)];
  const oracle = WORMHOLE_ORACLE[Number(output.chainId)];
  if (
    nativeId !== 1 ||
    !oracle ||
    oracle.toLowerCase() !== output.oracle.toLowerCase() ||
    output.settler.toLowerCase() !== SOLANA_OUTPUT_SETTLER.toLowerCase()
  ) {
    throw new Error("Wormhole Solana deployment is unavailable for this output.");
  }
  const connection = new Connection(solanaRpcUrl(output.chainId), "confirmed");
  const core = new PublicKey(SOLANA_WORMHOLE_CORE);
  const emitter = bytes32ToPubkey(output.oracle);
  if ((await connection.getGenesisHash()) !== SOLANA_GENESIS_HASHES[output.chainId.toString()]) {
    throw new Error("Wormhole Solana RPC serves the wrong cluster.");
  }
  const [state, program, coreProgram] = await Promise.all([
    connection.getAccountInfo(emitter),
    connection.getAccountInfo(new PublicKey(WORMHOLE_PROGRAM_ID)),
    connection.getAccountInfo(core)
  ]);
  if (
    !state ||
    !state.owner.equals(new PublicKey(WORMHOLE_PROGRAM_ID)) ||
    state.data.length !== 89 ||
    bytesToHex(state.data.subarray(0, 8)) !== STATE_DISCRIMINATOR ||
    !new PublicKey(state.data.subarray(40, 72)).equals(core) ||
    !program?.executable ||
    !coreProgram?.executable
  ) {
    throw new Error("Wormhole Solana oracle state/Core is unavailable or incompatible.");
  }
  return { connection, core, emitter, nativeId };
}

async function decodeAccountPublication(
  context: RecoveryConnection,
  account: AccountInfo<Buffer>,
  address: PublicKey,
  output: MandateOutput,
  expected: WormholeExpectedMessage,
  timestamp: number,
  txRef?: string
): Promise<WormholePublication | null> {
  if (!account.owner.equals(context.core)) return null;
  // Keep the SDK's platform-specific Anchor 0.29 graph out of the shared/browser chunk.
  const { deserializePostMessage } = await import("@wormhole-foundation/sdk-solana-core");
  try {
    const message = deserializePostMessage(new Uint8Array(account.data));
    if (
      bytesToHex(message.discriminator.subarray(0, 3)) !== "0x6d7367" ||
      message.payloadLength !== message.payload.length ||
      message.emitterChain !== context.nativeId ||
      bytesToHex(message.emitterAddress.toUint8Array()).toLowerCase() !==
        output.oracle.toLowerCase() ||
      message.nonce !== 0 ||
      message.timestamp < timestamp ||
      !matchesEnvelope(message.payload, expected)
    )
      return null;
    return {
      id: {
        network: "mainnet",
        emitterChain: context.nativeId,
        emitter: output.oracle,
        sequence: message.sequence.toString()
      },
      nonce: message.nonce,
      consistencyLevel: message.consistencyLevel,
      messageAccount: address.toBase58(),
      ...(txRef ? { txRef } : {})
    };
  } catch {
    return null;
  }
}

/** Re-read a publication before reuse; never trust a stored message identity. */
export async function verifySolanaWormholePublication(
  output: MandateOutput,
  expected: WormholeExpectedMessage,
  publication: WormholePublication
): Promise<WormholePublication | null> {
  const proof = taggedProof(output, expected);
  const context = await recoveryConnection(output);
  if (
    !publication?.id ||
    publication.id.network !== "mainnet" ||
    publication.id.emitterChain !== context.nativeId ||
    typeof publication.id.emitter !== "string" ||
    publication.id.emitter.toLowerCase() !== output.oracle.toLowerCase() ||
    typeof publication.id.sequence !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(publication.id.sequence) ||
    BigInt(publication.id.sequence) > 0xffffffffffffffffn
  )
    return null;
  const verifiedAccount = async (
    address: PublicKey,
    txRef?: string
  ): Promise<WormholePublication | null> => {
    const account = await context.connection.getAccountInfo(address);
    if (!account) return null;
    const actual = await decodeAccountPublication(
      context,
      account,
      address,
      output,
      expected,
      proof.timestamp,
      txRef
    );
    return actual?.id.sequence === publication.id.sequence ? actual : null;
  };
  if (typeof publication.messageAccount === "string") {
    let address: PublicKey | undefined;
    try {
      address = new PublicKey(publication.messageAccount);
    } catch {
      /* untrusted hint */
    }
    if (address) {
      const actual = await verifiedAccount(address);
      if (actual) return actual;
    }
  }
  if (isValidTxRef(publication.txRef, output.chainId)) {
    const tx = await context.connection.getTransaction(publication.txRef, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed"
    });
    if (tx?.meta && !tx.meta.err) {
      for (const address of await messageAccounts(context.connection, tx, context.core)) {
        const actual = await verifiedAccount(address, publication.txRef);
        if (actual) return actual;
      }
    }
  }
  const signed = await getSignedWormholeVaa(publication.id);
  if (signed.status === "pending") return null;
  const vaa = deserialize("Uint8Array", signed.bytes);
  if (vaa.timestamp < proof.timestamp || vaa.signatures.length === 0 || vaa.nonce !== 0)
    return null;
  const actual: WormholePublication = {
    id: { ...publication.id },
    nonce: vaa.nonce,
    consistencyLevel: vaa.consistencyLevel
  };
  assertWormholeVaa(signed.bytes, actual, expected);
  return actual;
}

/** Recover only actual Core-owned messages or exactly bound signed VAAs.
 * Structural VAA parsing here does not verify guardian signatures. */
export async function findSolanaWormholePublication(
  output: MandateOutput,
  expected: WormholeExpectedMessage,
  hint?: WormholePublication,
  messageAccount?: string
): Promise<WormholePublication | null> {
  const proof = taggedProof(output, expected);
  const context = await recoveryConnection(output);
  const { connection, core, emitter } = context;
  const candidates: WormholePublication[] = [];
  let incomplete = false;
  const inspectAccount = async (
    address: PublicKey,
    txRef?: string,
    required = true
  ): Promise<void> => {
    const account = await connection.getAccountInfo(address);
    if (!account) {
      if (required) incomplete = true;
      return;
    }
    const publication = await decodeAccountPublication(
      context,
      account,
      address,
      output,
      expected,
      proof.timestamp,
      txRef
    );
    if (
      publication &&
      !candidates.some((candidate) => candidate.id.sequence === publication.id.sequence)
    ) {
      candidates.push(publication);
    }
  };
  // Hints contain no trusted identity; resolve the public account independently.
  for (const locator of [messageAccount, hint?.messageAccount]) {
    if (typeof locator !== "string") continue;
    let address: PublicKey | undefined;
    try {
      address = new PublicKey(locator);
    } catch {
      /* malformed hint */
    }
    if (address) {
      try {
        await inspectAccount(address, undefined, false);
      } catch {
        /* rediscover an untrusted hint */
      }
    }
  }
  if (isValidTxRef(hint?.txRef, output.chainId)) {
    try {
      const tx = await connection.getTransaction(hint.txRef, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed"
      });
      if (tx?.meta && !tx.meta.err) {
        for (const address of await messageAccounts(connection, tx, core))
          await inspectAccount(address, hint.txRef, false);
      }
    } catch {
      /* rediscover an untrusted hint */
    }
  }
  try {
    let before: string | undefined;
    let ended = false;
    while (!ended) {
      const signatures = await connection.getSignaturesForAddress(
        emitter,
        { limit: 20, ...(before ? { before } : {}) },
        "confirmed"
      );
      if (signatures.length === 0) break;
      for (const entry of signatures) {
        if (entry.blockTime != null && entry.blockTime < proof.timestamp) {
          ended = true;
          break;
        }
        if (entry.err) continue;
        const tx = await connection.getTransaction(entry.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed"
        });
        if (!tx?.meta) {
          incomplete = true;
          continue;
        }
        if (tx.meta.err) continue;
        for (const address of await messageAccounts(connection, tx, core))
          await inspectAccount(address, entry.signature);
      }
      const cursor = signatures[signatures.length - 1]!.signature;
      if (cursor === before) throw new Error(HISTORY_UNAVAILABLE);
      before = cursor;
    }
  } catch {
    incomplete = true;
  }

  candidates.sort((a, b) => (BigInt(a.id.sequence) > BigInt(b.id.sequence) ? -1 : 1));
  const signedCandidates: WormholePublication[] = [];
  for (const candidate of candidates) {
    const signed = await getSignedWormholeVaa(candidate.id);
    if (signed.status === "vaa") {
      assertWormholeVaa(signed.bytes, candidate, expected);
      signedCandidates.push(candidate);
    }
  }
  // A consumed/closed local record cannot be re-consumed, even when RPC history is pruned.
  let publishable = false;
  let currentLocal = false;
  try {
    const address = localAttestationPda(outputSettlerSimplePda(), output.oracle, proof.localHash);
    const account = await connection.getAccountInfo(address);
    const local = classifyLocalAttestation(
      account
        ? {
            owner: account.owner.toBase58(),
            lamports: account.lamports,
            data: new Uint8Array(account.data)
          }
        : null,
      proof.timestamp
    );
    publishable =
      local.kind === "current" || (local.kind === "absent" && proof.kind === "non-fill");
    currentLocal = local.kind === "current";
  } catch {
    incomplete = true;
  }
  if (incomplete || (!candidates.length && !currentLocal)) {
    try {
      signedCandidates.push(...(await scanHistory(output, expected, proof.timestamp)));
    } catch (cause) {
      if (!candidates.length) throw new Error(HISTORY_UNAVAILABLE, { cause });
    }
  }
  if (signedCandidates.length) {
    signedCandidates.sort((a, b) => (BigInt(a.id.sequence) > BigInt(b.id.sequence) ? -1 : 1));
    const newest = signedCandidates[0]!;
    // Preserve verified chain transaction/account hints when Scan returns the same message.
    return candidates.find((candidate) => candidate.id.sequence === newest.id.sequence) ?? newest;
  }
  if (candidates.length) return candidates[0]!;
  if (incomplete || !publishable) throw new Error(HISTORY_UNAVAILABLE);
  return null;
}
