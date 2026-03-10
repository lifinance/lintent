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

export const POST: RequestHandler = async ({ request }) => {
  const {
    order,
    claimHash,
    blockNumber,
    chainId,
    mainnet
  }: {
    order: StandardOrder;
    claimHash: `0x${string}`;
    blockNumber: number;
    chainId: number;
    mainnet?: boolean;
  } = await request.json();
  console.log({ order, claimHash, blockNumber, chainId });

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

  console.log(dat);

  // create a JSON Response using a header we received
  return json({
    allocatorSignature: dat.result.allocatorSignature,
    allocatorAddress: dat.result.allocatorAddress
  });
};
