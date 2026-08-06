import { describe, expect, it } from "bun:test";
import { encodeEventTopics, toEventSelector, toEventSignature, type AbiEvent } from "viem";
import {
	EXPECTED_TOPIC0,
	PROVABLE_EVENTS,
	PROVABLE_EVENT_NAMES
} from "../../src/lib/libraries/provableEvents";

/**
 * The `/polymer` gate is a topic0 filter and nothing else, so these constants ARE the feature.
 * A drifted signature does not throw at runtime — it silently matches no logs and 400s every
 * proof request — which is exactly the failure a test has to catch instead of production.
 */
describe("provable event allowlist", () => {
	it("allows OutputFilled and OutputNotFilled, in that order", () => {
		expect([...PROVABLE_EVENT_NAMES]).toEqual(["OutputFilled", "OutputNotFilled"]);
		expect(PROVABLE_EVENTS.map((e) => e.name)).toEqual([...PROVABLE_EVENT_NAMES]);
	});

	it("derives each pinned topic0 from the ABI", () => {
		for (const event of PROVABLE_EVENTS) {
			expect(toEventSelector(event)).toBe(
				EXPECTED_TOPIC0[event.name as keyof typeof EXPECTED_TOPIC0]
			);
		}
	});

	it("pins the canonical OutputNotFilled signature", () => {
		// lifi-oif src/output/OutputSettlerBase.sol:112, with MandateOutput expanded in
		// declaration order. Confirmed on-chain: this topic0 is a PUSH32 constant in the
		// deployed OutputSettlerSimple (0x75220B7600c300005038432a0000f308e0000068) runtime
		// bytecode on Base, Arbitrum One and OP Mainnet.
		const notFilled = PROVABLE_EVENTS.find((e) => e.name === "OutputNotFilled") as AbiEvent;
		expect(toEventSignature(notFilled)).toBe(
			"OutputNotFilled(bytes32,(bytes32,bytes32,uint256,bytes32,uint256,bytes32,bytes,bytes),uint32)"
		);
		expect(toEventSelector(notFilled)).toBe(
			"0xf73516bd5d6277333b9b4d2830f5dab6de8d2f496097f7738b6e2e233119a2c7"
		);
	});

	it("indexes only orderId, so topic1 is the order id", () => {
		// The tuple and fillDeadline must stay in the data blob: moving one into topics would
		// change nothing about topic0 but would break every consumer that decodes the log.
		const notFilled = PROVABLE_EVENTS.find((e) => e.name === "OutputNotFilled") as AbiEvent;
		expect(notFilled.inputs.filter((i) => i.indexed).map((i) => i.name)).toEqual(["orderId"]);

		const orderId = `0x${"ab".repeat(32)}` as const;
		expect(encodeEventTopics({ abi: [notFilled], args: { orderId } })).toEqual([
			EXPECTED_TOPIC0.OutputNotFilled,
			orderId
		]);
	});

	it("keeps the two events distinguishable", () => {
		// A copy-paste that left both entries with the same signature would make the allowlist
		// look widened while proving nothing new.
		expect(EXPECTED_TOPIC0.OutputFilled).not.toBe(EXPECTED_TOPIC0.OutputNotFilled);
	});
});
