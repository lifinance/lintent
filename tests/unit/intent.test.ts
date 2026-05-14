import { describe, expect, it } from "bun:test";
import { Intent } from "../../src/lib/libraries/intent";
import type { chain, Token } from "../../src/lib/config";

const FORTY_FOUR_HOURS = 44 * 60 * 60; // 158_400
const TWO_DAYS = 2 * 24 * 60 * 60; // 172_800
const TEN_MINUTES = 10 * 60; // 600

function token(chain: chain): Token {
	return {
		address: "0x0000000000000000000000000000000000000001",
		name: "MOCK",
		chain,
		decimals: 18
	};
}

function makeIntent(inputChain: chain, outputChain: chain) {
	return new Intent({
		exclusiveFor: "",
		inputTokens: [{ token: token(inputChain), amount: 1n }],
		outputTokens: [{ token: token(outputChain), amount: 1n }],
		verifier: "polymer",
		account: () => "0x1111111111111111111111111111111111111111",
		lock: { type: "escrow" }
	});
}

function makeMultichainIntent(inputChains: chain[], outputChain: chain) {
	return new Intent({
		exclusiveFor: "",
		inputTokens: inputChains.map((c) => ({ token: token(c), amount: 1n })),
		outputTokens: [{ token: token(outputChain), amount: 1n }],
		verifier: "polymer",
		account: () => "0x1111111111111111111111111111111111111111",
		lock: { type: "escrow" }
	});
}

describe("Intent deadlines", () => {
	it("cross-chain singlechain order uses 44h fillDeadline and 2d expires", () => {
		const before = Math.floor(Date.now() / 1000);
		const { order } = makeIntent("base", "arbitrum").singlechain();
		const after = Math.floor(Date.now() / 1000);

		expect(order.fillDeadline).toBeGreaterThanOrEqual(before + FORTY_FOUR_HOURS);
		expect(order.fillDeadline).toBeLessThanOrEqual(after + FORTY_FOUR_HOURS);

		expect(order.expires).toBeGreaterThanOrEqual(before + TWO_DAYS);
		expect(order.expires).toBeLessThanOrEqual(after + TWO_DAYS);

		expect(order.fillDeadline).toBeLessThanOrEqual(order.expires);
	});

	it("same-chain singlechain order uses 10m fillDeadline and 10m expires", () => {
		const before = Math.floor(Date.now() / 1000);
		const { order } = makeIntent("base", "base").singlechain();
		const after = Math.floor(Date.now() / 1000);

		expect(order.fillDeadline).toBeGreaterThanOrEqual(before + TEN_MINUTES);
		expect(order.fillDeadline).toBeLessThanOrEqual(after + TEN_MINUTES);

		expect(order.expires).toBeGreaterThanOrEqual(before + TEN_MINUTES);
		expect(order.expires).toBeLessThanOrEqual(after + TEN_MINUTES);

		expect(order.fillDeadline).toBe(order.expires);
	});

	it("multichain order uses cross-chain (44h / 2d) deadlines", () => {
		const before = Math.floor(Date.now() / 1000);
		const { order } = makeMultichainIntent(["base", "arbitrum"], "ethereum").multichain();
		const after = Math.floor(Date.now() / 1000);

		expect(order.fillDeadline).toBeGreaterThanOrEqual(before + FORTY_FOUR_HOURS);
		expect(order.fillDeadline).toBeLessThanOrEqual(after + FORTY_FOUR_HOURS);

		expect(order.expires).toBeGreaterThanOrEqual(before + TWO_DAYS);
		expect(order.expires).toBeLessThanOrEqual(after + TWO_DAYS);

		expect(order.fillDeadline).toBeLessThanOrEqual(order.expires);
	});
});
