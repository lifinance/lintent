import { json } from "@sveltejs/kit";
import axios from "axios";
import type { RequestHandler } from "./$types";
import {
  PRIVATE_POLYMER_MAINNET_ZONE_API_KEY,
  PRIVATE_POLYMER_TESTNET_ZONE_API_KEY
} from "$env/static/private";
import { toByteArray } from "base64-js";
import { base58 } from "@scure/base";
import { verifyProvableLog } from "$lib/libraries/provableLogVerify";
import {
  POLYMER_SOLANA_PROGRAM_ID,
  verifyProvableSolanaLog
} from "$lib/libraries/provableSolanaLogVerify";
import { isSolanaChain } from "$lib/utils/chainType";

/**
 * Solana's chain id in Polymer's own registry.
 *
 * Polymer does NOT use the OIF chain id (1151111081099710 and friends) for
 * Solana; it has its own small integer namespace and rejects anything else with
 * `srcChainId is required for Solana and must be 2`. Read off that error from
 * the live API on 2026-08-14 — their docs do not state it.
 *
 * The cluster is selected by which API host we talk to (api.polymer.zone vs
 * api.testnet.polymer.zone), so this same id is used for both. Only mainnet has
 * been confirmed against the live API; devnet is assumed to match and is listed
 * as unverified in tests/fixtures/solana/PREFLIGHT.md.
 */
const POLYMER_SOLANA_CHAIN_ID = 2;

/**
 * Reads the request index out of a `polymer_requestProof` response.
 *
 * JSON-RPC reports failures in `error`, not by HTTP status, so axios resolves
 * happily and `result` is simply absent. Reading `.result` blindly yields
 * `undefined`, which then gets passed to `polymer_queryProof` and comes back as
 * a bare `not_found` — the caller sees "no proof yet" and polls forever for a
 * request that was never accepted. Fail loudly with Polymer's own reason
 * instead.
 */
function assertRequestAccepted(data: unknown, source: "solana" | "evm"): number {
  const body = data as { result?: unknown; error?: { code?: number; message?: string } };
  if (body?.error) {
    throw new Error(
      `Polymer rejected the ${source} proof request: ${body.error.message ?? "unknown error"}${
        body.error.code === undefined ? "" : ` (code ${body.error.code})`
      }`
    );
  }
  if (typeof body?.result !== "number") {
    throw new Error(
      `Polymer returned no request index for the ${source} proof request: ${JSON.stringify(data)}`
    );
  }
  return body.result;
}

function getPolymerUrl(mainnet: boolean) {
  return mainnet
    ? ("https://api.polymer.zone/v1/" as const)
    : ("https://api.testnet.polymer.zone/v1/" as const);
}

function getPolymerKey(mainnet: boolean) {
  return mainnet ? PRIVATE_POLYMER_MAINNET_ZONE_API_KEY : PRIVATE_POLYMER_TESTNET_ZONE_API_KEY;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Decode base58 and require an exact byte length, without throwing on malformed input. */
function isBase58OfLength(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return base58.decode(value).length === bytes;
  } catch {
    return false;
  }
}

/**
 * The request body, as a discriminated union:
 *
 * - `polymerIndex` present  — poll an existing job, no source-log fields needed (#64).
 * - `txSignature` present   — Solana source: a transaction signature plus the program that
 *                             emitted the `Prove:` log.
 * - otherwise               — EVM source: (block, globalLogIndex) coordinates.
 */
type PolymerRequestBody = {
  srcChainId?: number;
  srcBlockNumber?: number;
  globalLogIndex?: number;
  txSignature?: string;
  programID?: string;
  polymerIndex?: number;
  mainnet?: boolean;
};

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "Body must be a JSON object" }, { status: 400 });
  }

  const {
    srcChainId,
    srcBlockNumber,
    globalLogIndex,
    txSignature,
    programID,
    polymerIndex,
    mainnet
  } = body as PolymerRequestBody;

  const isPolling = polymerIndex !== undefined && polymerIndex !== null;
  // Discriminate on `txSignature` before the EVM validators run: a Solana request carries no
  // block number, so running them first would reject it as "Missing or invalid 'srcBlockNumber'".
  const isSolanaSource = !isPolling && typeof txSignature === "string";

  // The EVM validators below narrow these three fields, but that narrowing does not survive into
  // the request branch further down, which sits in a separate control-flow block. Capturing the
  // validated values keeps the proof request honest about what it actually verified, instead of
  // asserting non-null over an optional the type says may be missing.
  let evmSource: { srcChainId: number; srcBlockNumber: bigint; globalLogIndex: number } | undefined;

  if (mainnet !== undefined && mainnet !== null && typeof mainnet !== "boolean") {
    return json({ error: "Invalid 'mainnet'" }, { status: 400 });
  }
  const useMainnet = mainnet ?? true;

  if (isPolling) {
    if (!isPositiveInteger(polymerIndex)) {
      return json({ error: "Invalid 'polymerIndex'" }, { status: 400 });
    }
  } else if (isSolanaSource) {
    if (!isPositiveInteger(srcChainId) || !isSolanaChain(srcChainId)) {
      return json({ error: "Missing or invalid Solana 'srcChainId'" }, { status: 400 });
    }
    // A Solana signature is 64 bytes, not 32 — a base58 string that decodes to 32 is a pubkey,
    // not a signature.
    if (!isBase58OfLength(txSignature, 64)) {
      return json({ error: "Missing or invalid 'txSignature'" }, { status: 400 });
    }
    if (!isBase58OfLength(programID, 32)) {
      return json({ error: "Missing or invalid 'programID'" }, { status: 400 });
    }
    // Pinned: this endpoint spends the org's Polymer API key for unauthenticated callers, so it
    // must not prove logs of an arbitrary program. Same rationale as PROVABLE_EVENTS on EVM.
    if (programID !== POLYMER_SOLANA_PROGRAM_ID) {
      return json({ error: "'programID' is not the Polymer oracle program" }, { status: 400 });
    }
  } else {
    if (!isPositiveInteger(srcChainId)) {
      return json({ error: "Missing or invalid 'srcChainId'" }, { status: 400 });
    }
    if (!isPositiveInteger(srcBlockNumber)) {
      return json({ error: "Missing or invalid 'srcBlockNumber'" }, { status: 400 });
    }
    if (
      typeof globalLogIndex !== "number" ||
      !Number.isSafeInteger(globalLogIndex) ||
      globalLogIndex < 0
    ) {
      return json({ error: "Missing or invalid 'globalLogIndex'" }, { status: 400 });
    }
    evmSource = {
      srcChainId,
      srcBlockNumber: BigInt(srcBlockNumber),
      globalLogIndex
    };
  }

  try {
    const POLYMER_URL = getPolymerUrl(useMainnet);
    const PRIVATE_POLYMER_ZONE_API_KEY = getPolymerKey(useMainnet);

    let polymerRequestIndex = polymerIndex;
    if (isSolanaSource) {
      // Same pre-flight as the EVM path: confirm the transaction really carries the pinned
      // program's `Prove:` log before spending a Polymer proof request on it.
      const verification = await verifyProvableSolanaLog(
        Number(srcChainId),
        String(txSignature),
        String(programID)
      );
      if (verification === "mismatch") {
        console.warn("polymer proof request rejected: transaction has no Prove log", {
          srcChainId,
          txSignature
        });
        return json({ error: "transaction does not contain a Polymer Prove log" }, { status: 400 });
      }
      const requestProof = await axios.post(
        POLYMER_URL,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "polymer_requestProof",
          params: [
            {
              // Polymer's own id, not the OIF one we validate above — the two
              // namespaces are unrelated for Solana.
              srcChainId: POLYMER_SOLANA_CHAIN_ID,
              txSignature,
              programID
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${PRIVATE_POLYMER_ZONE_API_KEY}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          }
        }
      );
      polymerRequestIndex = assertRequestAccepted(requestProof.data, "solana");
    } else if (evmSource) {
      // V2-199 (#53) + #63: confirm the referenced log really is one of the allowlisted
      // output-settler events before spending a Polymer proof request on it.
      const verification = await verifyProvableLog(
        evmSource.srcChainId,
        evmSource.srcBlockNumber,
        evmSource.globalLogIndex
      );
      if (verification === "mismatch") {
        console.warn("polymer proof request rejected: log is not an allowlisted event", {
          srcChainId,
          srcBlockNumber,
          globalLogIndex
        });
        return json(
          { error: "log is not an OutputFilled or OutputNotFilled event" },
          { status: 400 }
        );
      }
      const requestProof = await axios.post(
        POLYMER_URL,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "polymer_requestProof",
          params: [
            {
              srcChainId,
              srcBlockNumber,
              globalLogIndex
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${PRIVATE_POLYMER_ZONE_API_KEY}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          }
        }
      );
      polymerRequestIndex = assertRequestAccepted(requestProof.data, "evm");
    }
    const requestProofData = await axios.post(
      POLYMER_URL,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "polymer_queryProof",
        params: [polymerRequestIndex]
      },
      {
        headers: {
          Authorization: `Bearer ${PRIVATE_POLYMER_ZONE_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );
    const dat: {
      jsonrpc: "2.0";
      id: 1;
      result: {
        jobID: number;
        createdAt: number;
        updatedAt: number;
      } & (
        | {
            status: "error";
            failureReason: string;
          }
        | {
            status: "complete";
            proof: "string";
          }
        // "initialized" and "pending" are both in-progress; "not_found" comes
        // back when the queried index does not exist. All three observed live —
        // only "error" and "complete" are terminal, and the caller polls on
        // anything else.
        | {
            status: "initialized" | "pending" | "not_found";
          }
      );
    } = requestProofData.data;

    let proof: string | undefined;
    if (dat.result.status === "complete") {
      proof = dat.result.proof;
      const proofBytes = toByteArray(proof);
      proof = Array.from(proofBytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    }

    return json({
      proof,
      polymerIndex: polymerRequestIndex,
      status: dat.result.status
    });
  } catch (error) {
    console.error("polymer proof request failed", {
      srcChainId,
      // Only the fields the caller actually sent: a Solana or polling request has no
      // (block, logIndex) coordinates, and logging them as undefined is noise.
      ...(isSolanaSource ? { txSignature, programID } : {}),
      ...(!isSolanaSource && !isPolling ? { srcBlockNumber, globalLogIndex } : {}),
      polymerIndex: polymerIndex ?? null,
      polling: isPolling,
      error: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "Polymer proof request failed" }, { status: 502 });
  }
};
