import {
  Intent,
  StandardEVMIntent,
  MultichainOrderIntent,
} from "@lifi/intent";
import type { CreateIntentOptions, IntentDeps } from "@lifi/intent";
import { POLYMER_ORACLE } from "../config/evm";

export type { CreateIntentOptions, IntentDeps };
export { StandardEVMIntent, MultichainOrderIntent };

export function buildEvmIntentDeps(mainnet: boolean): IntentDeps {
  void mainnet; // oracle map already covers both mainnet and testnet by chainId
  return {
    getOracle: (verifier, chainId) => {
      if (verifier === "polymer") {
        return POLYMER_ORACLE[Number(chainId)] ?? undefined;
      }
      return undefined;
    },
  };
}

export function buildEvmIntent(
  opts: CreateIntentOptions,
  deps: IntentDeps,
): StandardEVMIntent | MultichainOrderIntent {
  const intent = new Intent(opts, deps);
  const result = intent.isMultichain() ? intent.multichain() : intent.singlechain();
  if (result instanceof StandardEVMIntent || result instanceof MultichainOrderIntent) {
    return result as StandardEVMIntent | MultichainOrderIntent;
  }
  throw new Error("buildEvmIntent: unexpected intent type returned for EVM inputs");
}
