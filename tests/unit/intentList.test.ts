import { describe, expect, it } from "bun:test";
import {
	buildBaseIntentRow,
	EXPIRING_THRESHOLD_SECONDS,
	formatRelativeDeadline,
	formatRemaining,
	withTiming,
	type BaseIntentRow
} from "../../src/lib/libraries/intentList";

const baseRow: BaseIntentRow = {
	orderContainer: {
		inputSettler: "0x000025c3226C00B2Cdc200005a1600509f4e00C0",
		order: {
			user: "0x1111111111111111111111111111111111111111",
			nonce: 1n,
			originChainId: 8453n,
			expires: Math.floor(Date.now() / 1000) + 3600,
			fillDeadline: Math.floor(Date.now() / 1000) + 3600,
			inputOracle: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
			inputs: [[1n, 1n]],
			outputs: [
				{
					oracle: "0x0000000000000000000000000000000000000000000000000000000000000001",
					settler: "0x0000000000000000000000000000000000000000000000000000000000000002",
					chainId: 42161n,
					token: "0x0000000000000000000000000000000000000000000000000000000000000003",
					amount: 1n,
					recipient: "0x0000000000000000000000000000000000000004",
					callbackData: "0x",
					context: "0x00"
				}
			]
		},
		sponsorSignature: { type: "None", payload: "0x" },
		allocatorSignature: { type: "None", payload: "0x" }
	},
	orderId: "0xabc",
	orderIdShort: "0xabc",
	userShort: "0x1111...1111",
	fillDeadline: Math.floor(Date.now() / 1000) + 3600,
	inputCount: 1,
	outputCount: 1,
	chainScope: "singlechain",
	chainScopeBadge: "SingleChain",
	inputChips: [],
	inputOverflow: 0,
	outputChips: [],
	outputOverflow: 0,
	validationPassed: true,
	validationReason: "Validation pass"
};

describe("intentList timing and formatting", () => {
	it("marks expired rows", () => {
		const row = withTiming(baseRow, baseRow.fillDeadline + 1);
		expect(row.status).toBe("expired");
	});

	it("marks expiring rows", () => {
		const now = baseRow.fillDeadline - EXPIRING_THRESHOLD_SECONDS + 1;
		const row = withTiming(baseRow, now);
		expect(row.status).toBe("expiring");
	});

	it("formats remaining/relative deadline values", () => {
		expect(formatRemaining(59)).toBe("59s");
		expect(formatRemaining(180)).toBe("3m");
		expect(formatRelativeDeadline(30)).toBe("in 30s");
		expect(formatRelativeDeadline(-30)).toBe("30s ago");
	});

	it("builds rows for unknown chains without throwing", () => {
		const unknownChainId = 999999999n;
		const row = buildBaseIntentRow({
			inputSettler: "0x000025c3226C00B2Cdc200005a1600509f4e00C0",
			order: {
				user: "0x1111111111111111111111111111111111111111",
				nonce: 1n,
				originChainId: unknownChainId,
				expires: Math.floor(Date.now() / 1000) + 3600,
				fillDeadline: Math.floor(Date.now() / 1000) + 3600,
				inputOracle: "0x0000000000eC36B683C2E6AC89e9A75989C22a2e",
				inputs: [[1n, 1n]],
				outputs: [
					{
						oracle: "0x0000000000000000000000000000000000000000000000000000000000000001",
						settler: "0x0000000000000000000000000000000000000000000000000000000000000002",
						chainId: unknownChainId,
						token: "0x0000000000000000000000000000000000000000000000000000000000000003",
						amount: 1n,
						recipient: "0x0000000000000000000000000000000000000000000000000000000000000004",
						callbackData: "0x",
						context: "0x00"
					}
				]
			},
			sponsorSignature: { type: "None", payload: "0x" },
			allocatorSignature: { type: "None", payload: "0x" }
		});

		expect(row.inputChips[0].text).toContain("chain-999999999");
		expect(row.outputChips[0].text).toContain("chain-999999999");
		expect(row.inputChips[0].text).toContain("...");
		expect(row.outputChips[0].text).toContain("...");
	});
});
