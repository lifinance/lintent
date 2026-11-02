import { isSolanaChain } from "$lib/utils/chainType";

/**
 * Which PolymerOracle entry point accepts a proof from `outputChainId`.
 *
 * The oracle exposes two, and they decode different things:
 *
 * - `receiveMessage`       -> ICrossL2ProverV2.validateEvent   (an EVM event log)
 * - `receiveSolanaMessage` -> ICrossL2ProverV2.validateSolLogs (Solana program logs)
 *
 * Handing a Solana proof to the EVM entry point reverts with no reason string,
 * which is indistinguishable from a malformed proof and sends you looking in
 * the wrong place. Verified against the deployed Base oracle
 * (0x008C3800F3Ad9b3B662d002E90Cc00000000eE17) with a real Solana proof:
 * `receiveMessage` reverts, `receiveSolanaMessage` succeeds.
 *
 * Note the argument is the chain the proof came FROM — the output chain — not
 * the chain the call is made on.
 *
 * The two also key the attestation differently, which is why this is not merely
 * cosmetic: the EVM path stores under the local oracle's own identifier, the
 * Solana path under Polymer's authenticated `returnedProgramId`. That is the
 * reason a Solana output must carry the Polymer PROGRAM ID in `output.oracle`
 * rather than the oracle PDA — otherwise `isProven` looks in a slot nothing
 * ever wrote.
 */
export function polymerReceiveFunction(
  outputChainId: number | bigint
): "receiveMessage" | "receiveSolanaMessage" {
  return isSolanaChain(outputChainId) ? "receiveSolanaMessage" : "receiveMessage";
}
