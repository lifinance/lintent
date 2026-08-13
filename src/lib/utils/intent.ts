import {
  orderToIntent,
  StandardEVMIntent,
  StandardSolanaIntent,
  MultichainOrderIntent
} from "@lifi/intent";
import type { OrderContainer } from "@lifi/intent";
import { isSolanaChain, isTronChain } from "./chainType";

export function containerToIntent(
  container: OrderContainer
): StandardEVMIntent | StandardSolanaIntent | MultichainOrderIntent {
  const { inputSettler, order } = container;
  if (!("originChainId" in order)) {
    return orderToIntent({ namespace: "eip155", inputSettler, order });
  }
  if (isSolanaChain(order.originChainId)) {
    return orderToIntent({ namespace: "solana", inputSettler, order });
  }
  if (isTronChain(order.originChainId)) {
    return orderToIntent({ namespace: "tron", inputSettler, order });
  }
  return orderToIntent({ namespace: "eip155", inputSettler, order });
}
