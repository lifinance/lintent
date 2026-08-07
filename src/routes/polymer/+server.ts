import { json } from "@sveltejs/kit";
import axios from "axios";
import type { RequestHandler } from "./$types";
import {
  PRIVATE_POLYMER_MAINNET_ZONE_API_KEY,
  PRIVATE_POLYMER_TESTNET_ZONE_API_KEY
} from "$env/static/private";
import { toByteArray } from "base64-js";
import { verifyProvableLog } from "$lib/libraries/provableLogVerify";

function getPolymerUrl(mainnet: boolean) {
  return mainnet
    ? ("https://api.polymer.zone/v1/" as const)
    : ("https://api.testnet.polymer.zone/v1/" as const);
}

function getPolymerKey(mainnet: boolean) {
  return mainnet ? PRIVATE_POLYMER_MAINNET_ZONE_API_KEY : PRIVATE_POLYMER_TESTNET_ZONE_API_KEY;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { srcChainId, srcBlockNumber, globalLogIndex, polymerIndex, mainnet } = body as {
    srcChainId: number;
    srcBlockNumber: number;
    globalLogIndex: number;
    polymerIndex?: number;
    mainnet?: boolean;
  };

  // A caller that already holds a `polymerIndex` is polling an existing job, not asking us to
  // open a new one — the source-log coordinates are only needed on the request-a-proof path.
  // Validating them unconditionally made the documented poll-by-index flow unreachable: it
  // answered 400 in ~1ms without ever calling Polymer, and clients retrying that read it as a
  // stalled settlement.
  const isPolling = polymerIndex !== undefined && polymerIndex !== null;

  if (isPolling) {
    if (!isPositiveInteger(polymerIndex)) {
      return json({ error: "Invalid 'polymerIndex'" }, { status: 400 });
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
      !Number.isInteger(globalLogIndex) ||
      globalLogIndex < 0
    ) {
      return json({ error: "Missing or invalid 'globalLogIndex'" }, { status: 400 });
    }
  }

  try {
    const POLYMER_URL = getPolymerUrl(mainnet ?? true);
    const PRIVATE_POLYMER_ZONE_API_KEY = getPolymerKey(mainnet ?? true);

    let polymerRequestIndex = polymerIndex;
    if (!isPolling) {
      // V2-199 (#53) + #63: confirm the referenced log really is one of the allowlisted
      // output-settler events before spending a Polymer proof request on it.
      const verification = await verifyProvableLog(
        Number(srcChainId),
        BigInt(srcBlockNumber),
        Number(globalLogIndex)
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
      polymerRequestIndex = requestProof.data.result;
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
        | {
            status: "initialized";
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
      srcBlockNumber,
      globalLogIndex,
      polymerIndex: polymerIndex ?? null,
      polling: isPolling,
      error: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "Polymer proof request failed" }, { status: 502 });
  }
};
