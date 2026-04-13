import type { Connection } from "@solana/web3.js";

const CONFIRM_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

/**
 * Sends a serialized signed Solana transaction and waits for on-chain confirmation.
 *
 * Handles "already processed" gracefully — if the RPC reports the tx was already
 * included (e.g. Phantom sent it during signing), confirms it instead of throwing.
 *
 * If confirmation does not arrive within `confirmTimeoutMs` (default 30 s), the same
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
		const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

		let signature: string;
		try {
			signature = await connection.sendRawTransaction(rawTransaction, {
				skipPreflight: false,
				preflightCommitment: "confirmed"
			});
		} catch (sendErr: unknown) {
			const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
			if (msg.includes("already been processed") || msg.includes("AlreadyProcessed")) {
				const { base58 } = await import("@scure/base");
				const { Transaction } = await import("@solana/web3.js");
				try {
					const tx = Transaction.from(rawTransaction);
					const sig = base58.encode(tx.signature!);
					const status = await connection.getSignatureStatus(sig);
					if (
						status?.value?.confirmationStatus === "confirmed" ||
						status?.value?.confirmationStatus === "finalized"
					) {
						return sig;
					}
					await connection.confirmTransaction(sig, "confirmed");
					return sig;
				} catch {
					// Fall through to retry
				}
			}
			if (attempt < maxRetries) {
				lastError = sendErr instanceof Error ? sendErr : new Error(msg);
				continue;
			}
			throw sendErr;
		}

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
			if (!error.message.startsWith("Confirmation timed out")) {
				throw error;
			}
			lastError = error;
		}
	}

	throw lastError ?? new Error("Solana transaction failed to confirm");
}
