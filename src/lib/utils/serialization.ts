import type { OrderContainer } from "@lifi/intent";

/**
 * Serialize an OrderContainer to JSON.
 *
 * JSON.stringify does not support bigint natively — it throws a TypeError.
 * This replacer encodes bigint values as { __bigint: "<decimal string>" } so
 * the full OrderContainer (which contains bigints for chainId, nonce, amounts,
 * etc.) can survive a JSON round-trip through IndexedDB / localStorage.
 *
 * Use deserializeOrder to restore the bigint values.
 */
export function serializeOrder(order: OrderContainer): string {
	return JSON.stringify(order, (_key, value) =>
		typeof value === "bigint" ? { __bigint: value.toString() } : value
	);
}

/**
 * Restore an OrderContainer from JSON produced by serializeOrder.
 * The custom reviver re-hydrates { __bigint: "<decimal>" } back to bigint.
 */
export function deserializeOrder(data: string): OrderContainer {
	return JSON.parse(data, (_key, value) =>
		value && typeof value === "object" && "__bigint" in value && typeof value.__bigint === "string"
			? BigInt(value.__bigint)
			: value
	) as OrderContainer;
}
