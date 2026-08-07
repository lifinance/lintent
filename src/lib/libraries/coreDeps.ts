import {
  COIN_FILLER,
  HYPERLANE_ORACLE,
  INPUT_SETTLER_COMPACT_LIFI,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  POLYMER_ORACLE,
  TRON_MAINNET_OUTPUT_SETTLER,
  WORMHOLE_ORACLE
} from "$lib/config";
import { isTronChain } from "$lib/utils/chainType";
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
    // `buildMandateOutputs` special-cases only "polymer" (input chain's oracle);
    // every other cross-chain verifier is asked for the OUTPUT chain's oracle,
    // which is exactly what Hyperlane needs. See `allowedOutputOracles` below.
    if (verifier === "hyperlane") return HYPERLANE_ORACLE[key];
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
    const hyperlane = HYPERLANE_ORACLE[key];
    const allowed: `0x${string}`[] = [];
    if (polymer) allowed.push(polymer);
    if (isNonZeroAddress(wormhole)) allowed.push(wormhole);
    // Every verifier's input oracle lives on the input chain, Hyperlane included —
    // it is only `output.oracle` where the verifiers differ.
    if (isNonZeroAddress(hyperlane)) allowed.push(hyperlane);
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
    const outHyperlane = HYPERLANE_ORACLE[outKey];
    if (!outPolymer && !isNonZeroAddress(outWormhole) && !isNonZeroAddress(outHyperlane)) {
      return undefined;
    }
    if (sameChainFill) {
      // output.oracle is the output settler; the library no longer accepts
      // COIN_FILLER implicitly, so the EVM case must return it explicitly.
      return isTronChain(outputChainId)
        ? [
            TRON_MAINNET_OUTPUT_SETTLER,
            ...(TRON_LEGACY_OUTPUT_SETTLERS[outputChainId.toString()] ?? [])
          ]
        : [COIN_FILLER];
    }
    const allowed: `0x${string}`[] = [];

    // --- Polymer rule: output.oracle is the INPUT chain's oracle. ---------------
    // Polymer is pull-based: the proof is replayed onto the input chain and stored
    // under the input chain's oracle, so output.oracle must be exactly the oracle
    // this order's input chain is configured with (current or known-legacy
    // deployment). This rule is NOT shared with any other verifier.
    // `outPolymer` is required too: the fill has to be *observed* on the output chain by a
    // Polymer oracle before it can be replayed onto the input chain. Without that guard an
    // order into a Hyperlane-only chain (e.g. Stable, 988 — no Polymer deployment) would
    // validate purely because its input chain has a Polymer oracle, and then never prove.
    const inPolymer = POLYMER_ORACLE[Number(inputChainId)];
    if (outPolymer && inPolymer && inPolymer.toLowerCase() === inputOracle.toLowerCase()) {
      allowed.push(inPolymer);
    }
    const legacyOracles = outPolymer
      ? (TRON_LEGACY_POLYMER_ORACLES[inputChainId.toString()] ?? [])
      : [];
    for (const legacy of legacyOracles) {
      if (legacy.toLowerCase() === inputOracle.toLowerCase()) allowed.push(legacy);
    }

    // --- Hyperlane rule: output.oracle is the OUTPUT chain's oracle. ------------
    // Hyperlane is push-based: the solver calls `submit` on the OUTPUT chain's
    // oracle, which dispatches through the Mailbox; the relayer then calls
    // `handle` on the input chain's oracle, which records the sending oracle as
    // the message sender. `isProven(remoteChainId, remoteOracle, ...)` is therefore
    // keyed by the OUTPUT chain's oracle, and output.oracle must be that address —
    // the inverse of the Polymer rule above. Only accept it when this order's
    // input oracle really is the Hyperlane oracle on the input chain, so a Polymer
    // order can never be validated against a Hyperlane output oracle.
    const inHyperlane = HYPERLANE_ORACLE[Number(inputChainId)];
    if (
      isNonZeroAddress(inHyperlane) &&
      inHyperlane.toLowerCase() === inputOracle.toLowerCase() &&
      isNonZeroAddress(outHyperlane)
    ) {
      allowed.push(outHyperlane);
    }

    // Wormhole (stubbed: all-zero addresses today) also attests under the output
    // chain's oracle.
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
    return [COIN_FILLER];
  },
  supportsNativeOutput(chainId) {
    // Native (zero-token) outputs are only enabled for Tron in this release;
    // the deployed Tron output settler's fillOrderOutputs is payable.
    return isTronChain(chainId);
  }
};
