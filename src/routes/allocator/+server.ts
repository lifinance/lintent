import { json } from "@sveltejs/kit";
import axios from "axios";
import type { RequestHandler } from "./$types";
import { type StandardOrder } from "@lifi/intent";
import {
  PRIVATE_POLYMER_MAINNET_ZONE_API_KEY,
  PRIVATE_POLYMER_TESTNET_ZONE_API_KEY
} from "$env/static/private";

function getPolymerKey(mainnet: boolean) {
  return mainnet ? PRIVATE_POLYMER_MAINNET_ZONE_API_KEY : PRIVATE_POLYMER_TESTNET_ZONE_API_KEY;
}

function isHexString(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
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

  const { order, claimHash, blockNumber, chainId, mainnet } = body as {
    order: StandardOrder;
    claimHash: `0x${string}`;
    blockNumber: number;
    chainId: number;
    mainnet?: boolean;
  };

  if (!order || typeof order !== "object") {
    return json({ error: "Missing or invalid 'order'" }, { status: 400 });
  }
  if (!isHexString(claimHash)) {
    return json({ error: "Missing or invalid 'claimHash'" }, { status: 400 });
  }
  if (!isPositiveInteger(blockNumber)) {
    return json({ error: "Missing or invalid 'blockNumber'" }, { status: 400 });
  }
  if (!isPositiveInteger(chainId)) {
    return json({ error: "Missing or invalid 'chainId'" }, { status: 400 });
  }

  try {
    const PRIVATE_POLYMER_ZONE_API_KEY = getPolymerKey(mainnet ?? true);

    const requestAllocation = await axios.post(
      "https://allocator.devnet.polymer.zone/",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "allocator_attestCommit",
        params: [
          {
            chainId,
            blockNumber,
            claimHash,
            order
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

    const dat: {
      jsonrpc: "2.0";
      id: 1;
      result: {
        chainId: number;
        blockNumber: number;
        logIndex: number;
        order: StandardOrder;
        commitSignature: `0x${string}`;
        allocatorSignature: `0x${string}`;
        allocatorAddress: `0x${string}`;
        claimHash: `0x${string}`;
        sponsor: `0x${string}`;
        tokenBalances: {
          tokenId: `0x${string}`;
          balance: `0x${string}`;
        }[];
      };
    } = requestAllocation.data;

    return json({
      allocatorSignature: dat.result.allocatorSignature,
      allocatorAddress: dat.result.allocatorAddress
    });
  } catch (error) {
    console.error("allocator_attestCommit failed", { chainId });
    return json({ error: "Allocator request failed" }, { status: 502 });
  }
};
