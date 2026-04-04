import { describe, expect, it } from "bun:test";
import { serializeOrder, deserializeOrder } from "../../src/lib/utils/serialization";
import type { OrderContainer } from "@lifi/intent";

function makeOrder(): OrderContainer {
	return {
		inputSettler: "0x000025c3226C00B2Cdc200005a1600509f4e00C0",
		order: {
			user: "0x1111111111111111111111111111111111111111",
			nonce: 123n,
			originChainId: 8453n,
			expires: 1_900_000_000,
			fillDeadline: 1_900_000_000,
			inputOracle: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
			inputs: [[1_000_000n, 500_000n]],
			outputs: [
				{
					oracle: ("0x" + "00".repeat(32)) as `0x${string}`,
					settler: ("0x" + "00".repeat(32)) as `0x${string}`,
					chainId: 84532n,
					token: ("0x" + "00".repeat(32)) as `0x${string}`,
					amount: 999_999n,
					recipient: ("0x" + "00".repeat(20)) as `0x${string}`,
					callbackData: "0x",
					context: "0x"
				}
			]
		},
		sponsorSignature: { type: "None", payload: "0x" },
		allocatorSignature: { type: "None", payload: "0x" }
	};
}

describe("serializeOrder / deserializeOrder bigint round-trip", () => {
	it("preserves top-level bigint fields (nonce, originChainId)", () => {
		const original = makeOrder();
		const restored = deserializeOrder(serializeOrder(original));
		const order = restored.order as any;

		expect(typeof order.nonce).toBe("bigint");
		expect(order.nonce).toBe(123n);
		expect(typeof order.originChainId).toBe("bigint");
		expect(order.originChainId).toBe(8453n);
	});

	it("preserves bigints inside inputs tuples", () => {
		const original = makeOrder();
		const restored = deserializeOrder(serializeOrder(original));
		const inputs = (restored.order as any).inputs as [[bigint, bigint]];

		expect(typeof inputs[0][0]).toBe("bigint");
		expect(inputs[0][0]).toBe(1_000_000n);
		expect(typeof inputs[0][1]).toBe("bigint");
		expect(inputs[0][1]).toBe(500_000n);
	});

	it("preserves bigints inside outputs (amount, chainId)", () => {
		const original = makeOrder();
		const restored = deserializeOrder(serializeOrder(original));
		const out = restored.order.outputs[0];

		expect(typeof out.amount).toBe("bigint");
		expect(out.amount).toBe(999_999n);
		expect(typeof out.chainId).toBe("bigint");
		expect(out.chainId).toBe(84532n);
	});

	it("preserves non-bigint values unchanged", () => {
		const original = makeOrder();
		const restored = deserializeOrder(serializeOrder(original));

		expect(restored.inputSettler).toBe("0x000025c3226C00B2Cdc200005a1600509f4e00C0");
		expect((restored.order as any).expires).toBe(1_900_000_000);
		expect(restored.order.outputs[0].callbackData).toBe("0x");
		expect(restored.sponsorSignature).toEqual({ type: "None", payload: "0x" });
	});

	it("handles a very large bigint without precision loss", () => {
		const original = makeOrder();
		// Solana devnet chain ID — larger than Number.MAX_SAFE_INTEGER
		(original.order as any).originChainId = 1_151_111_081_099_712n;
		const restored = deserializeOrder(serializeOrder(original));
		expect((restored.order as any).originChainId).toBe(1_151_111_081_099_712n);
	});
});
