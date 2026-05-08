import { json } from "@sveltejs/kit";
import axios from "axios";
import type { RequestHandler } from "./$types";
import {
  PRIVATE_POLYMER_MAINNET_ZONE_API_KEY,
  PRIVATE_POLYMER_TESTNET_ZONE_API_KEY
} from "$env/static/private";

function getPolymerUrl(mainnet: boolean) {
  return mainnet
    ? ("https://api.polymer.zone/v1/" as const)
    : ("https://api.testnet.polymer.zone/v1/" as const);
}

function getPolymerKey(mainnet: boolean) {
  return mainnet ? PRIVATE_POLYMER_MAINNET_ZONE_API_KEY : PRIVATE_POLYMER_TESTNET_ZONE_API_KEY;
}

const MAX_CHAIN_IDS = 20;

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { chainIds, mainnet } = body as { chainIds?: number[]; mainnet?: boolean };

  if (chainIds !== undefined) {
    if (!Array.isArray(chainIds) || chainIds.length > MAX_CHAIN_IDS) {
      return json(
        { error: `'chainIds' must be an array with at most ${MAX_CHAIN_IDS} elements` },
        { status: 400 }
      );
    }
    if (!chainIds.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0)) {
      return json({ error: "'chainIds' must contain only positive integers" }, { status: 400 });
    }
  }

  try {
    const POLYMER_URL = getPolymerUrl(mainnet ?? true);
    const PRIVATE_POLYMER_ZONE_API_KEY = getPolymerKey(mainnet ?? true);

    const requestProofData = await axios.post(
      POLYMER_URL,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "info_health",
        params: [{ chain_ids: chainIds ?? [] }]
      },
      {
        headers: {
          Authorization: `Bearer ${PRIVATE_POLYMER_ZONE_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    const dat:
      | ({
          jsonrpc: "2.0";
          id: 1;
        } & {
          result: {
            status: {
              [chainId: string]: "healthy" | "unhealthy";
            };
          };
        })
      | { error: { code: -32000; message: `unsupported chain ID(s): [${string}]` } } =
      requestProofData.data;

    const failed = "error" in dat;
    const status = !failed ? dat.result.status : [];
    const error = failed ? dat.error : {};

    return json({
      failed,
      status,
      error
    });
  } catch (error) {
    console.error("polymer health check failed");
    return json({ error: "Polymer health check failed" }, { status: 502 });
  }
};
