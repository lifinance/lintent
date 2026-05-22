import { describe, expect, it } from "bun:test";
import { Intent } from "../../src/lib/libraries/intent";
import type { chain, Token } from "../../src/lib/config";

const FORTY_FOUR_HOURS = 44 * 60 * 60; // 158_400
const TWO_DAYS = 2 * 24 * 60 * 60; // 172_800
const FIVE_MINUTES = 5 * 60; // 300

function token(chain: chain): Token {
	return {
		address: "0x0000000000000000000000000000000000000001",
		name: "MOCK",
		chain,
		decimals: 18
	};
}

function makeIntent(inputChain: chain, outputChain: chain, exclusiveFor = "") {
	return new Intent({
		exclusiveFor,
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

	it("same-chain singlechain order uses 44h fillDeadline and 2d expires", () => {
		const before = Math.floor(Date.now() / 1000);
		const { order } = makeIntent("base", "base").singlechain();
		const after = Math.floor(Date.now() / 1000);

		expect(order.fillDeadline).toBeGreaterThanOrEqual(before + FORTY_FOUR_HOURS);
		expect(order.fillDeadline).toBeLessThanOrEqual(after + FORTY_FOUR_HOURS);

		expect(order.expires).toBeGreaterThanOrEqual(before + TWO_DAYS);
		expect(order.expires).toBeLessThanOrEqual(after + TWO_DAYS);

		expect(order.fillDeadline).toBeLessThanOrEqual(order.expires);
	});

	it("multichain order uses 44h fillDeadline and 2d expires", () => {
		const before = Math.floor(Date.now() / 1000);
		const { order } = makeMultichainIntent(["base", "arbitrum"], "ethereum").multichain();
		const after = Math.floor(Date.now() / 1000);

		expect(order.fillDeadline).toBeGreaterThanOrEqual(before + FORTY_FOUR_HOURS);
		expect(order.fillDeadline).toBeLessThanOrEqual(after + FORTY_FOUR_HOURS);

		expect(order.expires).toBeGreaterThanOrEqual(before + TWO_DAYS);
		expect(order.expires).toBeLessThanOrEqual(after + TWO_DAYS);

		expect(order.fillDeadline).toBeLessThanOrEqual(order.expires);
	});

	it("encodes exclusiveFor deadline as now + 5 minutes in output context", () => {
		const exclusiveFor = "0x2222222222222222222222222222222222222222";
		const before = Math.floor(Date.now() / 1000);
		const { order } = makeIntent("base", "arbitrum", exclusiveFor).singlechain();
		const after = Math.floor(Date.now() / 1000);

		const context = order.outputs[0].context;
		expect(context.length).toBeGreaterThan(2); // not just "0x"

		// Layout: bytes1 0xe0 || bytes32 exclusiveFor || uint32 deadline
		// = 37 bytes = 74 hex chars after the "0x" prefix.
		expect(context.length).toBe(2 + 74);

		const deadline = parseInt(context.slice(-8), 16);
		expect(deadline).toBeGreaterThanOrEqual(before + FIVE_MINUTES);
		expect(deadline).toBeLessThanOrEqual(after + FIVE_MINUTES);
	});
});
