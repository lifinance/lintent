import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
	computeStandardSolanaId,
	type MandateOutput,
	type OrderContainer,
	type StandardSolana
} from "@lifi/intent";
import {
	normalizeOrderContainer,
	reviveOrderBigInts
} from "../../src/lib/utils/reviveOrderBigInts";

const DEVNET_CHAIN_ID = 1151111081099712n;
const FAKE_ORACLE = ("0x" + "ab".repeat(32)) as `0x${string}`;
const FAKE_SETTLER = ("0x" + "cd".repeat(32)) as `0x${string}`;
const FAKE_TOKEN = ("0x" + "ef".repeat(32)) as `0x${string}`;
const FAKE_RECIPIENT = ("0x" + "12".repeat(32)) as `0x${string}`;

const MINT_BIGINT = BigInt("0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7");

const fakeOutput: MandateOutput = {
	oracle: FAKE_ORACLE,
	settler: FAKE_SETTLER,
	chainId: 84532n,
	token: FAKE_TOKEN,
	amount: 1_000_000n,
	recipient: FAKE_RECIPIENT,
	callbackData: "0x",
	context: "0x"
};

function makeSolanaOrder(): StandardSolana {
	return {
		user: ("0x" + "aa".repeat(20)) as `0x${string}`,
		nonce: 42n,
		originChainId: DEVNET_CHAIN_ID,
		expires: Math.floor(Date.now() / 1000) + 3600,
		fillDeadline: Math.floor(Date.now() / 1000) + 3599,
		inputOracle: ("0x" + "bb".repeat(20)) as `0x${string}`,
		inputs: [[MINT_BIGINT, 100_000n]],
		outputs: [fakeOutput]
	};
}

function makeContainer(order: StandardSolana): OrderContainer {
	return {
		order,
		inputSettler: ("0x" + "cc".repeat(20)) as `0x${string}`,
		sponsorSignature: { type: "None", payload: "0x" },
		allocatorSignature: { type: "None", payload: "0x" }
	};
}

describe("reviveOrderBigInts", () => {
	let prevToJson: unknown;

	beforeEach(() => {
		prevToJson = (BigInt.prototype as { toJSON?: unknown }).toJSON;
		(BigInt.prototype as { toJSON?: () => string }).toJSON = function () {
			return this.toString();
		};
	});

	afterEach(() => {
		if (prevToJson === undefined) {
			delete (BigInt.prototype as { toJSON?: unknown }).toJSON;
		} else {
			(BigInt.prototype as { toJSON?: unknown }).toJSON = prevToJson;
		}
	});

	it("round-trips StandardSolana so orderId and mint hex match live bigints", () => {
		const live = makeContainer(makeSolanaOrder());
		const idBefore = computeStandardSolanaId(live.order as StandardSolana);
		const mintHexBefore = BigInt((live.order as StandardSolana).inputs[0][0])
			.toString(16)
			.padStart(64, "0");

		const raw = JSON.parse(JSON.stringify(live)) as OrderContainer;
		const revived = reviveOrderBigInts(raw);
		const sol = revived.order as StandardSolana;

		expect(computeStandardSolanaId(sol)).toBe(idBefore);
		const mintHexAfter = BigInt(sol.inputs[0][0]).toString(16).padStart(64, "0");
		expect(mintHexAfter).toBe(mintHexBefore);
		expect(sol.inputs[0][1]).toBe(100_000n);
		expect(sol.nonce).toBe(42n);
		expect(sol.originChainId).toBe(DEVNET_CHAIN_ID);
		expect(sol.outputs[0].amount).toBe(1_000_000n);
		expect(sol.outputs[0].chainId).toBe(84532n);
	});

	it("normalizeOrderContainer revives bigints from an in-memory JSON round-trip", () => {
		const live = makeContainer(makeSolanaOrder());
		const normalized = normalizeOrderContainer(live);
		expect(computeStandardSolanaId(normalized.order as StandardSolana)).toBe(
			computeStandardSolanaId(live.order as StandardSolana)
		);
	});
});
