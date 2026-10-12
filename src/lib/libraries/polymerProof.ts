import axios from "axios";

/** Request body for the `/polymer` route: an EVM/Tron log or a Solana transaction. */
export type PolymerProofBody = {
  srcChainId: number;
  srcBlockNumber?: number;
  globalLogIndex?: number;
  txSignature?: string;
  programID?: string;
  mainnet: boolean;
};

export type PolymerPollResult =
  | { status: "complete"; proof: `0x${string}`; polymerIndex: number }
  | { status: "pending"; polymerIndex?: number };

/**
 * Asks the `/polymer` route for a proof, retrying while it is still being
 * generated. One request per entry in `waitsMs`, sleeping that long after each
 * non-final answer.
 *
 * `polymerIndex` identifies an already-placed request: threading it through
 * (and reporting it via `onIndex` so callers can persist it) makes each retry
 * a poll of the existing job rather than a fresh request against the org's
 * Polymer quota.
 *
 * Throws when Polymer reports the job failed — the index is dead then, and the
 * caller must drop it so the next attempt places a new request.
 */
export async function pollPolymerProof(
  body: PolymerProofBody,
  opts: { polymerIndex?: number; waitsMs: readonly number[]; onIndex?: (index: number) => void }
): Promise<PolymerPollResult> {
  let polymerIndex = opts.polymerIndex;
  for (const waitMs of opts.waitsMs) {
    const response = await axios.post(`/polymer`, { ...body, polymerIndex }, { timeout: 15_000 });
    const dat = response.data as {
      proof: undefined | string;
      polymerIndex: number;
      status?: "initialized" | "complete" | "error";
    };
    if (dat.polymerIndex !== undefined) {
      polymerIndex = dat.polymerIndex;
      opts.onIndex?.(polymerIndex);
    }
    if (dat.proof) {
      return {
        status: "complete",
        proof: `0x${dat.proof.replace(/^0x/, "")}`,
        polymerIndex: polymerIndex as number
      };
    }
    if (dat.status === "error") {
      throw new Error(
        `Polymer could not generate a proof for request ${polymerIndex} (job failed). Retrying will start a new request.`
      );
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, waitMs);
    await promise;
  }
  return { status: "pending", polymerIndex };
}
