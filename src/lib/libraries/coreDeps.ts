import {
  COIN_FILLER,
  INPUT_SETTLER_COMPACT_LIFI,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  POLYMER_ORACLE,
  SOLANA_OUTPUT_SETTLER,
  SOLANA_POLYMER_OUTPUT_ORACLE,
  TRON_MAINNET_OUTPUT_SETTLER,
  WORMHOLE_ORACLE
} from "$lib/config";
import { isSolanaChain, isTronChain } from "$lib/utils/chainType";
import type { IntentDeps, OrderContainerValidationDeps } from "@lifi/intent";
import { TRON_LEGACY_OUTPUT_SETTLERS, TRON_LEGACY_POLYMER_ORACLES } from "@lifi/intent";

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
    // Orders opened before an oracle rotation must stay displayable/provable.
    allowed.push(...(TRON_LEGACY_POLYMER_ORACLES[chainId.toString()] ?? []));
    if (allowed.length === 0) return undefined;
    // Same-chain fills use the output settler as the input oracle: the
    // global COIN_FILLER on EVM, the per-chain settler (current or legacy)
    // on Tron.
    if (sameChainFill) {
      if (isTronChain(chainId)) {
        allowed.push(
          TRON_MAINNET_OUTPUT_SETTLER,
          ...(TRON_LEGACY_OUTPUT_SETTLERS[chainId.toString()] ?? [])
        );
      } else if (isSolanaChain(chainId)) {
        allowed.push(SOLANA_OUTPUT_SETTLER);
      } else {
        allowed.push(COIN_FILLER);
      }
    }
    return allowed;
  },
  allowedOutputOracles({ inputChainId, inputOracle, outputChainId, sameChainFill }) {
    const outKey = Number(outputChainId);
    if (!Number.isFinite(outKey)) return undefined;
    const outPolymer = POLYMER_ORACLE[outKey];
    const outWormhole = WORMHOLE_ORACLE[outKey];
    if (!outPolymer && !isNonZeroAddress(outWormhole)) return undefined;
    if (sameChainFill) {
      // output.oracle is the output settler; the library no longer accepts
      // COIN_FILLER implicitly, so the EVM case must return it explicitly.
      if (isTronChain(outputChainId)) {
        return [
          TRON_MAINNET_OUTPUT_SETTLER,
          ...(TRON_LEGACY_OUTPUT_SETTLERS[outputChainId.toString()] ?? [])
        ];
      }
      return isSolanaChain(outputChainId) ? [SOLANA_OUTPUT_SETTLER] : [COIN_FILLER];
    }
    // A Solana OUTPUT is identified to Polymer by the oracle PROGRAM ID, not
    // by the input chain's oracle. The rule below only holds because
    // PolymerOracle is CREATE2-identical across EVM chains; on Solana,
    // oracle_polymer::submit compares against its own program id, so an order
    // built the EVM way fills and can then never be proven.
    if (isSolanaChain(outputChainId)) {
      return [SOLANA_POLYMER_OUTPUT_ORACLE];
    }
    const allowed: `0x${string}`[] = [];
    // Polymer stores proofs under the INPUT chain's oracle, so output.oracle
    // must be exactly the oracle this order's input chain is configured with
    // (current or known-legacy deployment).
    const inPolymer = POLYMER_ORACLE[Number(inputChainId)];
    if (inPolymer && inPolymer.toLowerCase() === inputOracle.toLowerCase()) {
      allowed.push(inPolymer);
    }
    const legacyOracles = TRON_LEGACY_POLYMER_ORACLES[inputChainId.toString()] ?? [];
    for (const legacy of legacyOracles) {
      if (legacy.toLowerCase() === inputOracle.toLowerCase()) allowed.push(legacy);
    }
    if (isNonZeroAddress(outWormhole)) allowed.push(outWormhole);
    return allowed;
  },
  allowedOutputSettlers(chainId) {
    // Legacy settlers stay listed so pre-rotation orders remain displayable
    // and provable; builders only ever emit the canonical settler.
    if (isTronChain(chainId)) {
      return [
        TRON_MAINNET_OUTPUT_SETTLER,
        ...(TRON_LEGACY_OUTPUT_SETTLERS[chainId.toString()] ?? [])
      ];
    }
    if (isSolanaChain(chainId)) return [SOLANA_OUTPUT_SETTLER];
    return [COIN_FILLER];
  },
  supportsNativeOutput(chainId) {
    // Tron's deployed fillOrderOutputs is payable; Solana has a dedicated
    // `native_fill` for zero-token outputs. Note this covers native OUTPUTS
    // only — a Solana order still cannot take a native SOL *input*, because
    // `open` has no such path, and that is rejected at issuance instead.
    return isTronChain(chainId) || isSolanaChain(chainId);
  }
};
