import { describe, expect, it } from "bun:test";
import { AssetSelection } from "../../src/lib/libraries/assetSelection";

describe("AssetSelection", () => {
	it("picks largest-first values to satisfy goal", () => {
		const selector = new AssetSelection({
			goal: 7n,
			values: [4n, 4n, 3n]
		}).largest();

		expect(selector.asValues()).toEqual([4n, 3n, 0n]);
	});

	it("picks smallest-first values to satisfy goal", () => {
		const selector = new AssetSelection({
			goal: 7n,
			values: [4n, 4n, 3n]
		}).smallest();

		expect(selector.asValues()).toEqual([4n, 0n, 3n]);
	});

	it("throws when goal is infeasible", () => {
		expect(() => new AssetSelection({ goal: 10n, values: [2n, 3n] })).toThrow();
	});
});
