import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { AXELAR_CHAIN_NAMES } from "$lib/config";

// Axelarscan rejects browser-origin requests (HTTP 403), so the estimate is
// fetched server-side.
const AXELARSCAN_API = "https://api.gmp.axelarscan.io/";
const GAS_LIMIT = "300000";
const GAS_MULTIPLIER = "2";

const knownChains: string[] = Object.values(AXELAR_CHAIN_NAMES).filter(
  (name) => name !== undefined
);

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sourceChain, destinationChain } = (body ?? {}) as {
    sourceChain?: unknown;
    destinationChain?: unknown;
  };
  if (typeof sourceChain !== "string" || !knownChains.includes(sourceChain)) {
    return json({ error: "Missing or unknown 'sourceChain'" }, { status: 400 });
  }
  if (typeof destinationChain !== "string" || !knownChains.includes(destinationChain)) {
    return json({ error: "Missing or unknown 'destinationChain'" }, { status: 400 });
  }

  const url = new URL(AXELARSCAN_API);
  url.search = new URLSearchParams({
    method: "estimateGasFee",
    sourceChain,
    destinationChain,
    gasLimit: GAS_LIMIT,
    gasMultiplier: GAS_MULTIPLIER
  }).toString();

  try {
    const response = await fetch(url);
    const fee = (await response.text()).trim().replace(/^"|"$/g, "");
    if (!response.ok || !/^\d+$/.test(fee)) {
      console.error("axelar gas estimate failed", { status: response.status, fee });
      return json({ error: "Axelar gas estimate failed" }, { status: 502 });
    }
    return json({ fee });
  } catch (error) {
    console.error("axelar gas estimate failed", error);
    return json({ error: "Axelar gas estimate failed" }, { status: 502 });
  }
};
