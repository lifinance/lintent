import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { buildTestnetGasRequest, estimateTestnetGas } from "$lib/libraries/axelarEstimate";
import { isTestnetCorridor, isStellarChain } from "$lib/config";

// Axelarscan rejects browser-origin requests (HTTP 403), so the estimate is
// fetched server-side.
const AXELARSCAN_API = "https://api.gmp.axelarscan.io/";
const GAS_LIMIT = "300000";
const GAS_MULTIPLIER = "2";

const knownChains = ["base", "arbitrum", "stellar"];

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body && typeof body === "object" && "sourceChainId" in body) {
    const input = body as {
      sourceChainId?: unknown;
      destinationChainId?: unknown;
      payloads?: unknown;
      stellarExecutor?: unknown;
    };
    if (
      typeof input.sourceChainId !== "number" ||
      typeof input.destinationChainId !== "number" ||
      !isTestnetCorridor(input.sourceChainId, input.destinationChainId) ||
      !Array.isArray(input.payloads) ||
      input.payloads.some((p) => typeof p !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(p)) ||
      (input.stellarExecutor !== undefined && typeof input.stellarExecutor !== "string")
    )
      return json({ error: "Only the configured testnet pair is allowed" }, { status: 400 });
    let estimateRequest;
    try {
      estimateRequest = buildTestnetGasRequest(
        input.sourceChainId,
        input.destinationChainId,
        input.payloads as `0x${string}`[],
        input.stellarExecutor as string | undefined
      );
    } catch (error) {
      return json({ error: (error as Error).message }, { status: 400 });
    }
    try {
      const fee = await estimateTestnetGas(
        estimateRequest,
        isStellarChain(input.sourceChainId) ? 7 : 18
      );
      return json({ fee: fee.toString() });
    } catch {
      return json(
        { error: "Testnet Axelar estimate unavailable; manual publication disabled" },
        { status: 502 }
      );
    }
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
