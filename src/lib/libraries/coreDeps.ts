import {
  AXELAR_NETWORKS,
  AXELAR_ORACLE,
  COIN_FILLER,
  INPUT_SETTLER_COMPACT_LIFI,
  isStellarChain,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  POLYMER_ORACLE,
  WORMHOLE_ORACLE,
  axelarCorridor,
  stellarSettlers
} from "$lib/config";
import { outputSettlerForStellar, stellarStrkeyToBytes32, type OrderContainer } from "@lifi/intent";
import type { IntentDeps, OrderContainerValidationDeps } from "@lifi/intent";

function isNonZeroAddress(value: string | undefined): value is `0x${string}` {
  return !!value && value.toLowerCase() !== "0x0000000000000000000000000000000000000000";
}

export const intentDeps: IntentDeps = {
  getStellarDeployment: stellarSettlers,
  getOracle(verifier, chainId) {
    const key = Number(chainId);
    if (!Number.isFinite(key)) return undefined;
    if (verifier === "polymer") return POLYMER_ORACLE[key];
    if (verifier === "wormhole") {
      return WORMHOLE_ORACLE[key];
    }
    if (verifier === "axelar") return AXELAR_ORACLE[key];
    return undefined;
  }
};

export const orderValidationDeps: OrderContainerValidationDeps = {
  inputSettlers: [
    INPUT_SETTLER_COMPACT_LIFI,
    MULTICHAIN_INPUT_SETTLER_COMPACT,
    stellarStrkeyToBytes32(AXELAR_NETWORKS.testnet.stellar.inputEscrow)
  ],
  allowedInputOracles({ chainId, sameChainFill }) {
    const key = Number(chainId);
    if (!Number.isFinite(key)) return undefined;
    const polymer = POLYMER_ORACLE[key];
    const wormhole = WORMHOLE_ORACLE[key];
    const axelar = AXELAR_ORACLE[key];
    const allowed: `0x${string}`[] = [];
    if (polymer) allowed.push(polymer);
    if (isNonZeroAddress(wormhole)) allowed.push(wormhole);
    if (axelar) allowed.push(axelar);
    if (allowed.length === 0) return undefined;
    if (sameChainFill) allowed.push(COIN_FILLER);
    return allowed;
  },
  allowedOutputOracles({ outputChainId, sameChainFill }) {
    const key = Number(outputChainId);
    if (!Number.isFinite(key)) return undefined;
    const polymer = POLYMER_ORACLE[key];
    const wormhole = WORMHOLE_ORACLE[key];
    const axelar = AXELAR_ORACLE[key];
    const allowed: `0x${string}`[] = [];
    if (polymer) allowed.push(polymer);
    if (isNonZeroAddress(wormhole)) allowed.push(wormhole);
    if (axelar) allowed.push(axelar);
    if (allowed.length === 0) return undefined;
    if (sameChainFill) allowed.push(COIN_FILLER);
    return allowed;
  },
  allowedOutputSettlers(chainId) {
    return isStellarChain(chainId)
      ? [outputSettlerForStellar(BigInt(chainId), stellarSettlers)]
      : [COIN_FILLER];
  }
};

/** Axelar orders stay readable; only supported corridors are writable. */
export function axelarActionBlocker(container: OrderContainer): string | undefined {
  const order = container.order;
  if (!("originChainId" in order)) return undefined;
  if (AXELAR_ORACLE[Number(order.originChainId)]?.toLowerCase() !== order.inputOracle.toLowerCase())
    return undefined;
  try {
    for (const output of order.outputs) axelarCorridor(order.originChainId, output.chainId);
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}
