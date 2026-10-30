import {
  AXELAR_ORACLE,
  COIN_FILLER,
  INPUT_SETTLER_COMPACT_LIFI,
  isStellarChain,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  POLYMER_ORACLE,
  WORMHOLE_ORACLE,
  stellarDeployment,
  requireAlignedAxelar,
  stellarTestnetConfig,
  STELLAR_TESTNET_ID
} from "$lib/config";
import { outputSettlerForStellar, type OrderContainer } from "@lifi/intent";
import type { IntentDeps, OrderContainerValidationDeps } from "@lifi/intent";

function isNonZeroAddress(value: string | undefined): value is `0x${string}` {
  return !!value && value.toLowerCase() !== "0x0000000000000000000000000000000000000000";
}

export const intentDeps: IntentDeps = {
  getStellarDeployment: stellarDeployment,
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
    ...(stellarTestnetConfig.enabled
      ? [stellarDeployment(BigInt(STELLAR_TESTNET_ID))!.inputEscrow]
      : [])
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
    if (!isStellarChain(chainId)) return [COIN_FILLER];
    try {
      return [outputSettlerForStellar(BigInt(chainId), stellarDeployment)];
    } catch {
      return [];
    }
  }
};

/** Legacy oracle identities remain readable; only the configured ABI-aligned pair is writable. */
export function axelarActionBlocker(container: OrderContainer): string | undefined {
  const order = container.order;
  if (!("originChainId" in order)) return undefined;
  if (AXELAR_ORACLE[Number(order.originChainId)]?.toLowerCase() !== order.inputOracle.toLowerCase())
    return undefined;
  try {
    for (const output of order.outputs) requireAlignedAxelar(order.originChainId, output.chainId);
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}
