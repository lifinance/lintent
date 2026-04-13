import { hashStruct, parseEventLogs } from "viem";
import type { TransactionReceipt } from "viem";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { compactTypes } from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";

/**
 * Find the OutputFilled log in a fill receipt that matches the given MandateOutput by structural hash.
 * Returns the extracted solver, timestamp, proof output, emitting contract, and log index — or null if not found.
 */
export function findOutputFilledLog(
	receipt: TransactionReceipt,
	output: MandateOutput
): {
	solverBytes32: `0x${string}`;
	fillTimestamp: number;
	proofOutput: MandateOutput;
	emittingContract: `0x${string}`;
	logIndex: number;
} | null {
	const logs = parseEventLogs({
		abi: COIN_FILLER_ABI,
		eventName: "OutputFilled",
		logs: receipt.logs
	});
	const expectedHash = hashStruct({
		types: compactTypes,
		primaryType: "MandateOutput",
		data: output
	});
	const match = logs.find(
		(log) =>
			hashStruct({ types: compactTypes, primaryType: "MandateOutput", data: log.args.output }) ===
			expectedHash
	);
	if (!match) return null;
	return {
		solverBytes32: match.args.solver as `0x${string}`,
		fillTimestamp: Number(match.args.timestamp),
		proofOutput: match.args.output as MandateOutput,
		emittingContract: match.address as `0x${string}`,
		logIndex: match.logIndex
	};
}
