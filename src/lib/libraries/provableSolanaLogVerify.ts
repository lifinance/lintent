// `$env/dynamic/private`, not `$env/static/private`: this variable is optional
// (there is a public fallback below), and the static form fails the module
// import outright when the key is absent from .env — which would take the
// whole /polymer route down, not just Solana verification.
import { env } from "$env/dynamic/private";
import { isSolanaMainnet } from "$lib/utils/chainType";

/**
 * The Solana program `/polymer` will mint a proof for.
 *
 * This is a pin, not a convenience: the endpoint spends the org's Polymer API key on behalf of an
 * unauthenticated caller, so it must not become a general-purpose proof oracle for arbitrary
 * Solana programs — the same reasoning as the event allowlist in `provableEvents.ts`. Widening it
 * widens what anyone can get proved.
 *
 * Confirmed against `declare_id!` in
 * `catalyst-intent-svm/programs/oracles/oracle_polymer/src/lib.rs`. Polymer authenticates this
 * value as `returnedProgramId`, parsed out of the `program: {program_id}` field of the log line
 * that `oracle_polymer::submit` emits.
 */
export const POLYMER_SOLANA_PROGRAM_ID = "LiFiBtfyPT1DnTHTAeZ2rwr5RgMrThwA5kt7KGT5nBV";

export type ProvableSolanaLogVerification = "match" | "mismatch" | "unknown";

// A Cloudflare Worker request is short-lived, so a hung Solana RPC must not hold the proof
// request open behind it.
const RPC_TIMEOUT_MS = 5_000;

// Public fallbacks, used only when no private endpoint is configured. `PRIVATE_SOLANA_RPC_URL` is
// a single endpoint by design: a deployment talks to one Solana network, and pointing it at the
// wrong one simply yields "unknown" (transaction not found) rather than a false "match".
const DEFAULT_MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";
const DEFAULT_DEVNET_RPC_URL = "https://api.devnet.solana.com";

function getSolanaRpcUrl(chainId: number): string {
  const configured = env.PRIVATE_SOLANA_RPC_URL?.trim();
  if (configured) return configured;
  return isSolanaMainnet(chainId) ? DEFAULT_MAINNET_RPC_URL : DEFAULT_DEVNET_RPC_URL;
}

type GetTransactionResponse = {
  result?: { meta?: { logMessages?: string[] | null } | null } | null;
  error?: { message?: string };
};

/**
 * Pre-flight check that `txSignature` really is a transaction in which the pinned Polymer oracle
 * program logged a proof, so a proof request cannot be aimed at an unrelated Solana transaction.
 *
 * The marker is the log line `oracle_polymer::submit` emits via `msg!`:
 *     `Prove: program: {program_id}, {base64(source || payload)}`
 * which Solana surfaces in `meta.logMessages` prefixed with `Program log: `. Matching on
 * `Prove: program: <programId>,` therefore checks both the marker and the program identity that
 * Polymer will authenticate as `returnedProgramId`.
 *
 * Advisory by design, exactly like `verifyProvableLog`: an RPC failure — or a transaction the RPC
 * has not indexed yet — returns "unknown" and the caller proceeds, so an infra blip never blocks
 * the happy path.
 */
export async function verifyProvableSolanaLog(
  chainId: number,
  txSignature: string,
  programId: string
): Promise<ProvableSolanaLogVerification> {
  try {
    const response = await fetch(getSolanaRpcUrl(chainId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [
          txSignature,
          {
            encoding: "json",
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
          }
        ]
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`solana rpc responded ${response.status}`);

    const body = (await response.json()) as GetTransactionResponse;
    if (body.error) throw new Error(body.error.message ?? "solana rpc error");

    // Null result means "not indexed here (yet)", not "not a Prove transaction" — a freshly
    // landed fill is the common case — so it stays inconclusive rather than becoming a rejection.
    const logMessages = body.result?.meta?.logMessages;
    if (!body.result || !logMessages) return "unknown";

    const marker = `Prove: program: ${programId},`;
    return logMessages.some((line) => line.includes(marker)) ? "match" : "mismatch";
  } catch (e) {
    console.warn("solana provable-log verification failed", {
      chainId,
      txSignature,
      error: e instanceof Error ? e.message : String(e)
    });
    return "unknown";
  }
}
