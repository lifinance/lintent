import {
  orderToIntent,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_TESTNET_CHAIN_ID,
  SOLANA_DEVNET_CHAIN_ID,
  StandardEVMIntent,
  StandardSolanaIntent,
  MultichainOrderIntent
} from "@lifi/intent";
import type { OrderContainer } from "@lifi/intent";

const SOLANA_CHAIN_IDS = new Set([
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_TESTNET_CHAIN_ID,
  SOLANA_DEVNET_CHAIN_ID
]);

export function containerToIntent(
  container: OrderContainer
): StandardEVMIntent | StandardSolanaIntent | MultichainOrderIntent {
  const { inputSettler, order } = container;
  if (!("originChainId" in order)) {
    return orderToIntent({ namespace: "eip155", inputSettler, order });
  }
  if (SOLANA_CHAIN_IDS.has(order.originChainId)) {
    return orderToIntent({ namespace: "solana", inputSettler, order });
  }
  return orderToIntent({ namespace: "eip155", inputSettler, order });
}
