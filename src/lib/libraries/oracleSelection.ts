import { getOracle, getChainName, type Verifier } from "$lib/config";
import { isEvmChain } from "$lib/utils/chainType";

export function oracleSelectionProblem(
  verifier: Verifier,
  inputChains: (number | bigint)[],
  outputChains: (number | bigint)[]
): string | undefined {
  const chains = [...new Set([...inputChains, ...outputChains].map(Number))];
  if (chains.length <= 1) return undefined;
  if (verifier === "vow" && chains.some((chain) => !isEvmChain(chain))) {
    return "Vow supports EVM chains only. Choose EVM inputs and outputs or another verifier.";
  }
  for (const chain of chains) {
    if (!getOracle(verifier, chain)) {
      return `${verifier === "vow" ? "Vow" : verifier} is not configured on ${getChainName(chain)}.`;
    }
  }
}

export function quoteOracleSelection(
  verifier: Verifier,
  inputChains: (number | bigint)[],
  outputChains: (number | bigint)[]
): { chainId: number; address: `0x${string}` }[] | undefined {
  const problem = oracleSelectionProblem(verifier, inputChains, outputChains);
  if (problem) throw new Error(problem);
  const chains = [...new Set([...inputChains, ...outputChains].map(Number))];
  if (verifier !== "vow" || chains.length <= 1) return undefined;
  return chains.map((chainId) => ({ chainId, address: getOracle("vow", chainId)! }));
}
