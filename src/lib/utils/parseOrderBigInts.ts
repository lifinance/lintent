import type { MandateOutput, MultichainOrder, OrderContainer, StandardOrder } from "@lifi/intent";

/** Coerce values restored from JSON (decimal strings) back to bigint. */
function toBigInt(v: bigint | string | number): bigint {
	if (typeof v === "bigint") return v;
	if (typeof v === "string") return BigInt(v);
	return BigInt(v);
}

function parseMandateOutputBigInts(o: MandateOutput): MandateOutput {
	return {
		...o,
		chainId: toBigInt(o.chainId as bigint | string | number),
		amount: toBigInt(o.amount as bigint | string | number)
	};
}

function parseInputPairs(pairs: readonly [unknown, unknown][]): [bigint, bigint][] {
	return pairs.map(([a, b]) => [
		toBigInt(a as bigint | string | number),
		toBigInt(b as bigint | string | number)
	]);
}

function parseStandardOrderBigInts(order: StandardOrder): StandardOrder {
	const inputs = parseInputPairs(
		order.inputs as unknown as [unknown, unknown][]
	) as StandardOrder["inputs"];
	return {
		...order,
		nonce: toBigInt(order.nonce as bigint | string | number),
		originChainId: toBigInt(order.originChainId as bigint | string | number),
		inputs,
		outputs: order.outputs.map(parseMandateOutputBigInts)
	};
}

function parseMultichainOrderBigInts(order: MultichainOrder): MultichainOrder {
	return {
		...order,
		nonce: toBigInt(order.nonce as bigint | string | number),
		outputs: order.outputs.map(parseMandateOutputBigInts),
		inputs: order.inputs.map((entry) => ({
			chainId: toBigInt(entry.chainId as bigint | string | number),
			inputs: parseInputPairs(entry.inputs as unknown as [unknown, unknown][])
		}))
	};
}

/**
 * After JSON.parse, bigint fields are decimal strings (see BigInt.prototype.toJSON in +page.svelte).
 * Restore proper bigints for order IDs, PDAs, and UI.
 */
export function parseOrderBigInts(container: OrderContainer): OrderContainer {
	const { order } = container;
	if ("originChainId" in order) {
		return { ...container, order: parseStandardOrderBigInts(order) };
	}
	return { ...container, order: parseMultichainOrderBigInts(order as MultichainOrder) };
}
