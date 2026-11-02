import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { buildAxelarGasRequest, estimateAxelarGas } from "$lib/libraries/axelarEstimate";
import { findAxelarCorridor, isStellarChain } from "$lib/config";

// Axelarscan rejects browser-origin requests (HTTP 403), so the estimate is
// fetched server-side, only from the corridor network's fixed estimator URL.
export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const input = (body && typeof body === "object" ? body : {}) as {
    sourceChainId?: unknown;
    destinationChainId?: unknown;
    payloads?: unknown;
    stellarExecutor?: unknown;
  };
  const corridor =
    typeof input.sourceChainId === "number" && typeof input.destinationChainId === "number"
      ? findAxelarCorridor(input.sourceChainId, input.destinationChainId)
      : undefined;
  if (
    !corridor ||
    !Array.isArray(input.payloads) ||
    input.payloads.some((p) => typeof p !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(p)) ||
    (input.stellarExecutor !== undefined && typeof input.stellarExecutor !== "string")
  )
    return json({ error: "Only supported Axelar corridors are allowed" }, { status: 400 });
  const sourceChainId = input.sourceChainId as number;
  let estimateRequest;
  try {
    estimateRequest = buildAxelarGasRequest(
      sourceChainId,
      input.destinationChainId as number,
      input.payloads as `0x${string}`[],
      input.stellarExecutor as string | undefined
    );
  } catch (error) {
    return json({ error: (error as Error).message }, { status: 400 });
  }
  try {
    const fee = await estimateAxelarGas(
      estimateRequest,
      corridor.network.estimatorUrl,
      isStellarChain(sourceChainId) ? 7 : 18
    );
    return json({ fee: fee.toString() });
  } catch {
    return json(
      { error: "Axelar estimate unavailable; manual publication disabled" },
      { status: 502 }
    );
  }
};
