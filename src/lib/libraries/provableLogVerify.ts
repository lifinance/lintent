import { createPublicClient, http } from "viem";
import { PRIVATE_ROUTEMESH_API_KEY } from "$env/static/private";
import { PROVABLE_EVENTS } from "$lib/libraries/provableEvents";

export type ProvableLogVerification = "match" | "mismatch" | "unknown";

/**
 * Pre-flight check that (block, logIndex) really points at one of the allowlisted output-settler
 * events, so a proof request cannot be aimed at an unrelated log.
 *
 * Advisory by design: an RPC failure returns "unknown" and the caller proceeds, so an infra blip
 * never blocks the happy path.
 */
export async function verifyProvableLog(
	chainId: number,
	blockNumber: bigint,
	globalLogIndex: number
): Promise<ProvableLogVerification> {
	try {
		const client = createPublicClient({
			transport: http(`https://lb.routeme.sh/rpc/${chainId}/${PRIVATE_ROUTEMESH_API_KEY}`)
		});
		// `events` (plural), not `event`: viem collapses the singular form into an exact
		// `topics: [topic0]` filter, while the plural form emits `topics: [[topic0a, topic0b]]`
		// — an OR-set — which is what lets both events through in a single call.
		const logs = await client.getLogs({
			fromBlock: blockNumber,
			toBlock: blockNumber,
			events: PROVABLE_EVENTS
		});
		return logs.some((l) => Number(l.logIndex) === globalLogIndex) ? "match" : "mismatch";
	} catch (e) {
		console.warn("routemesh provable-log verification failed", {
			chainId,
			blockNumber: blockNumber.toString(),
			globalLogIndex,
			error: e instanceof Error ? e.message : String(e)
		});
		return "unknown";
	}
}
