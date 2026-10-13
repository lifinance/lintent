import type { IntentApi } from "@lifi/intent";
import axios from "axios";
import { bytes32ToAddress } from "@lifi/intent";
import { chainMetaById, WORMHOLE_CHAIN_IDS, WORMHOLE_ORACLE, type Verifier } from "$lib/config";
import { resolveAddressForChainType } from "$lib/utils/address";
import { formatAddressForChain, getChainType, namespaceForChain } from "$lib/utils/chainType";

// The SDK does not export these API types; keep its exact public method contract.
export type QuoteOptions = Parameters<IntentApi["getQuotes"]>[0];
export type QuoteResponse = Awaited<ReturnType<IntentApi["getQuotes"]>>;
type OracleQuote = QuoteResponse["quotes"][number] & {
  metadata: { oracle?: { input?: unknown; output?: unknown } };
};
type OracleDeployment = { chain: string; address: string };

/** isCurrent reads the live request identity, including changes before effect flush. */
export type QuoteEligibility = { verifier: Verifier; isCurrent: () => boolean };

function nativeAddress(value: string, chainId: number | bigint): string {
  const kind = getChainType(chainId);
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
    if (kind !== "solana") {
      if (!/^0x0{24}/i.test(value)) throw new Error("Quote address has non-zero EVM padding.");
      value = bytes32ToAddress(value as `0x${string}`);
    } else {
      return formatAddressForChain(value as `0x${string}`, chainId);
    }
  }
  const address = resolveAddressForChainType(value, kind);
  if (!address) throw new Error(`Invalid quote address for chain ${chainId}.`);
  return formatAddressForChain(address, chainId);
}

function matchesOracle(value: unknown, chainId: number | bigint): boolean {
  if (typeof value !== "string") return false;
  try {
    const actual = nativeAddress(value, chainId);
    const expected = nativeAddress(WORMHOLE_ORACLE[Number(chainId)]!, chainId);
    return getChainType(chainId) === "solana"
      ? actual === expected
      : actual.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

/** Never ask for an unconstrained quote when the selected provider is unavailable. */
export async function getVerifierQuotes(
  api: IntentApi,
  options: QuoteOptions,
  verifier: Verifier
): Promise<QuoteResponse> {
  const { inputs, outputs } = options;
  const sameChain =
    inputs.length > 0 &&
    outputs.length > 0 &&
    [...inputs, ...outputs].every(({ chainId }) => BigInt(chainId) === BigInt(inputs[0].chainId));
  if (verifier === "polymer" || sameChain) return api.getQuotes(options);
  if (inputs.length === 0 || outputs.length === 0) return { quotes: [] };

  const chainIds = [
    ...new Set(
      [options.userChainId, ...inputs.map((i) => i.chainId), ...outputs.map((o) => o.chainId)].map(
        String
      )
    )
  ];
  const deployments: OracleDeployment[] = [];
  let network: boolean | undefined;
  for (const chainIdText of chainIds) {
    const chainId = Number(chainIdText);
    const metadata = chainMetaById[chainId];
    const oracle = WORMHOLE_ORACLE[chainId];
    if (
      !Number.isSafeInteger(chainId) ||
      !metadata ||
      !oracle ||
      !WORMHOLE_CHAIN_IDS[chainId] ||
      getChainType(chainId) === "tron"
    ) {
      return { quotes: [] };
    }
    if (network !== undefined && network !== metadata.testnet) return { quotes: [] };
    network = metadata.testnet;
    deployments.push({
      chain: `${namespaceForChain(chainId)}:${chainId}`,
      address: nativeAddress(oracle, chainId)
    });
  }
  // One recorded inputOracle must be valid on every input chain.
  if (
    !inputs.every((input) =>
      matchesOracle(WORMHOLE_ORACLE[Number(inputs[0].chainId)], input.chainId)
    )
  ) {
    return { quotes: [] };
  }

  const intent: Record<string, unknown> = {
    intentType: "oif-swap",
    swapType: options.swapType ?? "exact-input",
    inputs: inputs.map((input) => ({
      chain: `${namespaceForChain(input.chainId)}:${input.chainId}`,
      user: nativeAddress(input.sender, input.chainId),
      asset: nativeAddress(input.asset, input.chainId),
      amount: input.amount.toString()
    })),
    outputs: outputs.map((output) => ({
      chain: `${namespaceForChain(output.chainId)}:${output.chainId}`,
      receiver: nativeAddress(output.receiver, output.chainId),
      asset: nativeAddress(output.asset, output.chainId),
      ...(output.amount !== undefined ? { amount: output.amount.toString() } : {})
    })),
    metadata: {
      oracle: deployments,
      ...(options.exclusiveFor?.length
        ? {
            exclusiveFor: options.exclusiveFor.map((solver) =>
              nativeAddress(solver, inputs[0].chainId)
            )
          }
        : {})
    }
  };
  for (const key of ["minValidUntil", "preference", "partialFill", "failureHandling"] as const) {
    if (options[key] !== undefined) intent[key] = options[key];
  }

  // Installed SDK 0.6.0 drops oracle filters entirely, including EVM filters.
  // Use the same v1 request for all remote Wormhole routes; never fall back to it unfiltered.
  const { data } = await axios.post<QuoteResponse>(
    new URL("/api/v1/integrator/quote/request", api.baseUrl).toString(),
    {
      user: {
        chain: `${namespaceForChain(options.userChainId)}:${options.userChainId}`,
        address: nativeAddress(options.user, options.userChainId)
      },
      intent,
      supportedTypes: ["oif-user-open-v0"]
    },
    {
      timeout: 15_000,
      headers: options.integratorKey ? { "X-Integrator-Key": options.integratorKey } : undefined
    }
  );
  const quotes: QuoteResponse["quotes"] = [];
  for (const quote of data?.quotes ?? []) {
    const oracle = (quote as OracleQuote).metadata?.oracle;
    if (
      !oracle ||
      !inputs.every((input) => matchesOracle(oracle.input, input.chainId)) ||
      !outputs.every((output) => matchesOracle(oracle.output, output.chainId))
    )
      continue;
    try {
      const solver = quote.metadata.exclusiveFor;
      quotes.push({
        ...quote,
        metadata: {
          ...quote.metadata,
          exclusiveFor: Array.isArray(solver)
            ? solver.map((address) => nativeAddress(address, inputs[0].chainId))
            : solver === null
              ? null
              : nativeAddress(solver, inputs[0].chainId)
        }
      });
    } catch {
      // An identity the origin cannot pay is not an eligible quote.
    }
  }
  return { ...data, quotes };
}
