import type { Connection } from "@solana/web3.js";

const CONFIRM_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 1;

/**
 * Sends a serialized signed Solana transaction and waits for on-chain confirmation.
 *
 * If confirmation does not arrive within `confirmTimeoutMs` (default 5 s), the same
 * transaction is re-submitted once more and the wait is repeated. Throws if all
 * attempts are exhausted without confirmation.
 *
 * Program-level errors (returned inside the confirmed result) are thrown immediately
 * without retrying — only confirmation timeouts trigger a retry.
 *
 * @param connection      Solana RPC connection
 * @param rawTransaction  Serialized signed transaction (output of `tx.serialize()`)
 * @returns               Transaction signature
 */
export async function sendAndConfirmSolanaTx(
	connection: Connection,
	rawTransaction: Uint8Array,
	options?: { confirmTimeoutMs?: number; maxRetries?: number }
): Promise<string> {
	const timeoutMs = options?.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
	const maxRetries = options?.maxRetries ?? MAX_RETRIES;

	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		// Fetch a fresh blockhash anchor for the confirmation polling window.
		// The transaction's own embedded blockhash (valid ~90 slots / ~60 s) remains unchanged.
		const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

		const signature = await connection.sendRawTransaction(rawTransaction, {
			skipPreflight: false,
			preflightCommitment: "confirmed"
		});

		try {
			const result = await Promise.race([
				connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed"),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error(`Confirmation timed out after ${timeoutMs / 1_000}s`)),
						timeoutMs
					)
				)
			]);

			if (result.value.err) {
				throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
			}

			return signature;
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			// Program / simulation errors are not retriable — surface them immediately.
			if (!error.message.startsWith("Confirmation timed out")) {
				throw error;
			}
			lastError = error;
		}
	}

	throw lastError ?? new Error("Solana transaction failed to confirm");
}
