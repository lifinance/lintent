import { json } from "@sveltejs/kit";
import axios from "axios";
import type { RequestHandler } from "./$types";
import {
  PRIVATE_POLYMER_MAINNET_ZONE_API_KEY,
  PRIVATE_POLYMER_TESTNET_ZONE_API_KEY
} from "$env/static/private";
import { toByteArray } from "base64-js";

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

  try {
    const POLYMER_URL = getPolymerUrl(mainnet ?? true);
    const PRIVATE_POLYMER_ZONE_API_KEY = getPolymerKey(mainnet ?? true);

    let polymerRequestIndex = polymerIndex;
    if (!polymerRequestIndex) {
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
    console.error("polymer proof request failed", { srcChainId });
    return json({ error: "Polymer proof request failed" }, { status: 502 });
  }
};
