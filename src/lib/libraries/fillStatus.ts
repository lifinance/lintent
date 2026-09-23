// One chain-aware "has this output been filled?" check.
//
// This existed in three shapes before: flowProgress had EVM and Tron branches,
// while FillIntent.svelte called `getClient` unconditionally — which throws for
// Tron and would throw for Solana too. Routing both through here means the two
// cannot drift, which is the whole reason the duplicate was a problem.

import { getOutputHash } from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import { BYTES32_ZERO, getClient } from "$lib/config";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { bytes32ToAddress } from "@lifi/intent";
import { isSolanaChain, isTronChain } from "$lib/utils/chainType";
import { getSolanaReads } from "$lib/solana/client";
import { readIsOutputFilled as readIsSolanaOutputFilled } from "$lib/solana/reads";
import { getTronReads } from "$lib/tron/client";
import { readIsOutputFilled as readIsTronOutputFilled } from "$lib/tron/reads";
import { solanaFillEvidence } from "./solanaHistory";

export async function isOutputFilled(
  orderId: `0x${string}`,
  output: MandateOutput,
  fillSignature?: string
): Promise<boolean> {
  const outputHash = getOutputHash(output);

  if (isSolanaChain(output.chainId)) {
    // A closed FillRecord is not proof that a fill never happened. Verified
    // transaction logs survive rent reclamation, including after a reload.
    if (await solanaFillEvidence(orderId, output, fillSignature)) return true;
    const reads = await getSolanaReads(output.chainId);
    return readIsSolanaOutputFilled(reads, { orderId, output });
  }

  if (isTronChain(output.chainId)) {
    return readIsTronOutputFilled(await getTronReads(), output.settler, orderId, outputHash);
  }

  const record = await getClient(output.chainId).readContract({
    address: bytes32ToAddress(output.settler),
    abi: COIN_FILLER_ABI,
    functionName: "getFillRecord",
    args: [orderId, outputHash]
  });
  return record !== BYTES32_ZERO;
}
