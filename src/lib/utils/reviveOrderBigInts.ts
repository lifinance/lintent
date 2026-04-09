import type { MandateOutput, MultichainOrder, OrderContainer, StandardOrder } from "@lifi/intent";

/** Coerce values restored from JSON (decimal strings) back to bigint. */
function bi(v: bigint | string | number): bigint {
	if (typeof v === "bigint") return v;
	if (typeof v === "string") return BigInt(v);
	return BigInt(v);
}

function reviveMandateOutput(o: MandateOutput): MandateOutput {
	return {
		...o,
		chainId: bi(o.chainId as bigint | string | number),
		amount: bi(o.amount as bigint | string | number)
	};
}

function reviveInputPairs(pairs: readonly [unknown, unknown][]): [bigint, bigint][] {
	return pairs.map(([a, b]) => [
		bi(a as bigint | string | number),
		bi(b as bigint | string | number)
	]);
}

function reviveStandardOrder(order: StandardOrder): StandardOrder {
	const inputs = reviveInputPairs(
		order.inputs as unknown as [unknown, unknown][]
	) as StandardOrder["inputs"];
	return {
		...order,
		nonce: bi(order.nonce as bigint | string | number),
		originChainId: bi(order.originChainId as bigint | string | number),
		inputs,
		outputs: order.outputs.map(reviveMandateOutput)
	};
}

function reviveMultichainOrder(order: MultichainOrder): MultichainOrder {
	return {
		...order,
		nonce: bi(order.nonce as bigint | string | number),
		outputs: order.outputs.map(reviveMandateOutput),
		inputs: order.inputs.map((entry) => ({
			chainId: bi(entry.chainId as bigint | string | number),
			inputs: reviveInputPairs(entry.inputs as unknown as [unknown, unknown][])
		}))
	};
}

/**
 * Same revival as after `loadOrdersFromDb`, for orders still in memory (avoids wrong orderId / PDAs
 * until a full page reload). Requires `BigInt.prototype.toJSON` (set in +page.svelte) so stringify works.
 */
export function normalizeOrderContainer(container: OrderContainer): OrderContainer {
	return reviveOrderBigInts(JSON.parse(JSON.stringify(container)) as OrderContainer);
}

/**
 * After JSON.parse, bigint fields are decimal strings (see BigInt.prototype.toJSON in +page.svelte).
 * Restore proper bigints for order IDs, PDAs, and UI.
 */
export function reviveOrderBigInts(container: OrderContainer): OrderContainer {
	const { order } = container;
	if ("originChainId" in order) {
		return { ...container, order: reviveStandardOrder(order) };
	}
	return { ...container, order: reviveMultichainOrder(order as MultichainOrder) };
}
