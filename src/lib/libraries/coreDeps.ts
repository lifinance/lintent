import {
  COIN_FILLER,
  INPUT_SETTLER_COMPACT_LIFI,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  POLYMER_ORACLE,
  WORMHOLE_ORACLE
} from "$lib/config";
import type { IntentDeps, OrderContainerValidationDeps } from "@lifi/intent";

function isNonZeroAddress(value: string | undefined): value is `0x${string}` {
  return !!value && value.toLowerCase() !== "0x0000000000000000000000000000000000000000";
}

export const intentDeps: IntentDeps = {
  getOracle(verifier, chainId) {
    const key = Number(chainId);
    if (!Number.isFinite(key)) return undefined;
    if (verifier === "polymer") return POLYMER_ORACLE[key];
    if (verifier === "wormhole") {
      return WORMHOLE_ORACLE[key];
    }
    return undefined;
  }
};

export const orderValidationDeps: OrderContainerValidationDeps = {
  inputSettlers: [INPUT_SETTLER_COMPACT_LIFI, MULTICHAIN_INPUT_SETTLER_COMPACT],
  allowedInputOracles({ chainId, sameChainFill }) {
    const key = Number(chainId);
    if (!Number.isFinite(key)) return undefined;
    const polymer = POLYMER_ORACLE[key];
    const wormhole = WORMHOLE_ORACLE[key];
    const allowed: `0x${string}`[] = [];
    if (polymer) allowed.push(polymer);
    if (isNonZeroAddress(wormhole)) allowed.push(wormhole);
    if (allowed.length === 0) return undefined;
    if (sameChainFill) allowed.push(COIN_FILLER);
    return allowed;
  },
  allowedOutputOracles(chainId) {
    const key = Number(chainId);
    if (!Number.isFinite(key)) return undefined;
    const polymer = POLYMER_ORACLE[key];
    const wormhole = WORMHOLE_ORACLE[key];
    const allowed: `0x${string}`[] = [];
    if (polymer) allowed.push(polymer);
    if (isNonZeroAddress(wormhole)) allowed.push(wormhole);
    if (allowed.length === 0) return undefined;
    return allowed;
  },
  allowedOutputSettlers() {
    return [COIN_FILLER];
  }
};
