import axios from "axios";
import {
  AXELAR_CHAIN_NAMES,
  AXELAR_GAS_FLOOR,
  isStellarChain,
  isTestnetCorridor,
  isChainIdTestnet
} from "$lib/config";

export function axelarChainName(chainId: number | bigint): string {
  const name = AXELAR_CHAIN_NAMES[Number(chainId)];
  if (!name) throw new Error(`No Axelar chain name for chain ${chainId}`);
  return name;
}

/**
 * Gas to prepay for an Axelar message, in the source chain's base unit:
 * the Axelarscan estimate (via the /axelar/gas proxy), never below the
 * configured floor. Falls back to the floor if the estimate is unavailable.
 */
export async function axelarGasFee(
  sourceChainId: number | bigint,
  destinationChainId: number | bigint,
  payloads?: `0x${string}`[],
  stellarExecutor?: string
): Promise<bigint> {
  if (isTestnetCorridor(sourceChainId, destinationChainId)) {
    const { data } = await axios.post<{ fee: string }>("/axelar/gas", {
      sourceChainId: Number(sourceChainId),
      destinationChainId: Number(destinationChainId),
      payloads,
      stellarExecutor
    });
    if (!/^\d+$/.test(data.fee) || BigInt(data.fee) <= 0n)
      throw new Error("Testnet Axelar gas estimate unavailable");
    return BigInt(data.fee);
  }
  const floor = AXELAR_GAS_FLOOR[Number(sourceChainId)];
  if (floor === undefined) throw new Error(`No Axelar gas floor for chain ${sourceChainId}`);
  try {
    const { data } = await axios.post<{ fee: string }>("/axelar/gas", {
      sourceChain: axelarChainName(sourceChainId),
      destinationChain: axelarChainName(destinationChainId)
    });
    const estimate = BigInt(data.fee);
    return estimate > floor ? estimate : floor;
  } catch (error) {
    console.warn("Axelar gas estimate unavailable, using floor", error);
    return floor;
  }
}

/** Axelarscan GMP page of a submit transaction; Stellar hashes carry no 0x prefix there. */
export function axelarscanUrl(txHash: `0x${string}`, sourceChainId: number | bigint) {
  const hash = isStellarChain(sourceChainId) ? txHash.replace(/^0x/, "") : txHash;
  return `https://${isChainIdTestnet(sourceChainId) ? "testnet." : ""}axelarscan.io/gmp/${hash}`;
}
