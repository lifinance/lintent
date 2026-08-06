import { createPublicClient, http } from "viem";
import { PRIVATE_ROUTEMESH_API_KEY } from "$env/static/private";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";

const OUTPUT_FILLED_EVENT = COIN_FILLER_ABI.find(
  (item) => item.type === "event" && item.name === "OutputFilled"
) as Extract<(typeof COIN_FILLER_ABI)[number], { type: "event"; name: "OutputFilled" }>;

export type OutputFilledVerification = "match" | "mismatch" | "unknown";

export async function verifyOutputFilledLog(
  chainId: number,
  blockNumber: bigint,
  globalLogIndex: number
): Promise<OutputFilledVerification> {
  try {
    const client = createPublicClient({
      transport: http(`https://lb.routeme.sh/rpc/${chainId}/${PRIVATE_ROUTEMESH_API_KEY}`)
    });
    const logs = await client.getLogs({
      fromBlock: blockNumber,
      toBlock: blockNumber,
      event: OUTPUT_FILLED_EVENT
    });
    return logs.some((l) => Number(l.logIndex) === globalLogIndex) ? "match" : "mismatch";
  } catch (e) {
    console.warn("routemesh OutputFilled verification failed", {
      chainId,
      blockNumber: blockNumber.toString(),
      globalLogIndex,
      error: e instanceof Error ? e.message : String(e)
    });
    return "unknown";
  }
}
