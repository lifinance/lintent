import axios from "axios";
import { axelarCorridor, isStellarChain, isChainIdTestnet } from "$lib/config";

/**
 * Gas to prepay for an Axelar message, in the source chain's base unit: the
 * network's Axelarscan estimate via the /axelar/gas proxy. There is no floor;
 * an unavailable estimate disables publication.
 */
export async function axelarGasFee(
  sourceChainId: number | bigint,
  destinationChainId: number | bigint,
  payloads: `0x${string}`[],
  stellarExecutor?: string
): Promise<bigint> {
  axelarCorridor(sourceChainId, destinationChainId);
  const { data } = await axios.post<{ fee: string }>("/axelar/gas", {
    sourceChainId: Number(sourceChainId),
    destinationChainId: Number(destinationChainId),
    payloads,
    stellarExecutor
  });
  if (!/^\d+$/.test(data.fee) || BigInt(data.fee) <= 0n)
    throw new Error("Axelar gas estimate unavailable");
  return BigInt(data.fee);
}

/** Axelarscan GMP page of a submit transaction; Stellar hashes carry no 0x prefix there. */
export function axelarscanUrl(txHash: `0x${string}`, sourceChainId: number | bigint) {
  const hash = isStellarChain(sourceChainId) ? txHash.replace(/^0x/, "") : txHash;
  return `https://${isChainIdTestnet(sourceChainId) ? "testnet." : ""}axelarscan.io/gmp/${hash}`;
}
