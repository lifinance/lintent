import {
	orderToIntent,
	SOLANA_MAINNET_CHAIN_ID,
	SOLANA_TESTNET_CHAIN_ID,
	SOLANA_DEVNET_CHAIN_ID
} from "@lifi/intent";
import type { OrderContainer, OrderIntent } from "@lifi/intent";

const SOLANA_CHAIN_IDS = new Set([
	SOLANA_MAINNET_CHAIN_ID,
	SOLANA_TESTNET_CHAIN_ID,
	SOLANA_DEVNET_CHAIN_ID
]);

function isSolanaOrder(order: OrderContainer["order"]): boolean {
	if (!("originChainId" in order)) return false;
	return SOLANA_CHAIN_IDS.has(order.originChainId);
}

export function containerToIntent(container: OrderContainer): OrderIntent {
	const { inputSettler, order } = container;
	if (isSolanaOrder(order)) {
		return orderToIntent({ namespace: "solana", inputSettler, order });
	}
	return orderToIntent({ namespace: "eip155", inputSettler, order });
}
