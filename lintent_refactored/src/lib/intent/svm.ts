import { keccak256 } from "viem";
import {
  Intent,
  computeStandardSolanaId,
  borshEncodeSolanaOrder,
} from "@lifi/intent";
import type { IntentDeps, TokenContext, StandardSolanaIntent } from "@lifi/intent";
import {
  POLYMER_ORACLE_PDA,
  SOLANA_DEVNET_PDAS,
  SOLANA_MAINNET_PDAS,
  SOLANA_DEVNET_VIEM_CHAIN_ID,
  SOLANA_MAINNET_VIEM_CHAIN_ID,
} from "../config/svm";
import {
  solanaAddressToBytes32,
  bytes32ToSolanaAddress,
  getSharedPolymerOracle,
} from "../config/shared";
import type { SvmOrderData } from "../../types/shared";

/** Pad a 20-byte EVM address to a 32-byte hex string (left-zero-padded). */
function evmAddrToBytes32(addr: `0x${string}`): `0x${string}` {
  return `0x${addr.replace("0x", "").padStart(64, "0")}`;
}

/**
 * Build IntentDeps for Solana-originated intents.
 * - For the Solana input chain: returns the Polymer oracle PDA (bytes32).
 * - For EVM output chains: returns the Polymer oracle EVM address (bytes32-padded).
 */
export function buildSvmIntentDeps(mainnet: boolean): IntentDeps {
  const polymerOracleMap = getSharedPolymerOracle(mainnet);
  const solanaChainId = BigInt(
    mainnet ? SOLANA_MAINNET_VIEM_CHAIN_ID : SOLANA_DEVNET_VIEM_CHAIN_ID,
  );
  const pdas = mainnet ? SOLANA_MAINNET_PDAS : SOLANA_DEVNET_PDAS;

  return {
    getOracle: (verifier, chainId) => {
      if (verifier !== "polymer") return undefined;
      if (chainId === solanaChainId) {
        // Input chain oracle: Polymer PDA on Solana
        return pdas.POLYMER_ORACLE as `0x${string}`;
      }
      // Output chain oracle: Polymer contract on the EVM chain
      const addr = polymerOracleMap[Number(chainId)];
      return addr ? evmAddrToBytes32(addr) : undefined;
    },
  };
}

export type BuildSvmIntentOptions = {
  /** Solana wallet public key (base58). */
  account: string;
  inputToken: {
    mintBytes32: `0x${string}`;
    name: string;
    chainId: bigint;
    decimals: number;
    amount: bigint;
  };
  outputTokens: TokenContext[];
  verifier: "polymer";
  /** Bytes32 recipient for outputs. Defaults to the user's bytes32. */
  outputRecipient?: `0x${string}`;
};

/**
 * Build a StandardSolanaIntent using the unified Intent class.
 * Converts the Solana-specific inputs into the format expected by @lifi/intent.
 */
export function buildSvmIntent(
  opts: BuildSvmIntentOptions,
  deps: IntentDeps,
): StandardSolanaIntent {
  const accountBytes32 = solanaAddressToBytes32(opts.account);

  const inputTokens: TokenContext[] = [
    {
      token: {
        address: opts.inputToken.mintBytes32,
        name: opts.inputToken.name,
        chainId: opts.inputToken.chainId,
        decimals: opts.inputToken.decimals,
        chainNamespace: "solana" as const,
      },
      amount: opts.inputToken.amount,
    },
  ];

  const result = new Intent(
    {
      account: accountBytes32,
      inputTokens,
      outputTokens: opts.outputTokens,
      verifier: opts.verifier,
      outputRecipient: opts.outputRecipient,
      lock: { type: "escrow" as const },
    },
    deps,
  ).singlechain();

  return result as StandardSolanaIntent;
}

/**
 * Re-compute the order ID for a stored SvmOrderData.
 * Uses the same Borsh encoding as the on-chain program.
 */
export function computeSvmOrderId(orderData: SvmOrderData): `0x${string}` {
  return computeStandardSolanaId({
    user: orderData.userBytes32,
    nonce: orderData.nonce,
    originChainId: orderData.originChainId,
    expires: orderData.expires,
    fillDeadline: orderData.fillDeadline,
    inputOracle: orderData.inputOracleBytes32,
    inputs: [[BigInt(orderData.input.tokenBytes32), orderData.input.amount]],
    outputs: orderData.outputs,
  });
}

export { solanaAddressToBytes32, bytes32ToSolanaAddress };
export { POLYMER_ORACLE_PDA };
export type { StandardSolanaIntent };

// Re-export for consumers that previously imported borshEncodeSvmOrder
export { borshEncodeSolanaOrder };
