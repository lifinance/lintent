import { describe, expect, it } from "bun:test";
import { solanaAddressToBytes32, isValidSolanaAddress } from "../../src/lib/utils/solana";

describe("solanaAddressToBytes32", () => {
	it("converts the system program (all-zeros) to 32 zero bytes", () => {
		// System program public key = 11111111111111111111111111111111 (base58 for 32 zero bytes)
		const result = solanaAddressToBytes32("11111111111111111111111111111111");
		expect(result).toBe(("0x" + "00".repeat(32)) as `0x${string}`);
	});

	it("produces a 0x-prefixed 66-character hex string (32 bytes)", () => {
		const result = solanaAddressToBytes32("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
		expect(result).toMatch(/^0x[0-9a-f]{64}$/);
		expect(result.length).toBe(66);
	});

	it("round-trips: two conversions of the same address produce the same hex", () => {
		const addr = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
		expect(solanaAddressToBytes32(addr)).toBe(solanaAddressToBytes32(addr));
	});

	it("produces distinct hex for two different addresses", () => {
		const a = solanaAddressToBytes32("11111111111111111111111111111111");
		const b = solanaAddressToBytes32("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
		expect(a).not.toBe(b);
	});
});

describe("isValidSolanaAddress", () => {
	it("accepts a valid Base58 public key", () => {
		expect(isValidSolanaAddress("11111111111111111111111111111111")).toBe(true);
	});

	it("accepts a well-known program address", () => {
		expect(isValidSolanaAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")).toBe(true);
	});

	it("rejects an empty string", () => {
		expect(isValidSolanaAddress("")).toBe(false);
	});

	it("rejects a plain word", () => {
		expect(isValidSolanaAddress("not-a-pubkey")).toBe(false);
	});

	it("rejects an EVM hex address", () => {
		expect(isValidSolanaAddress("0x1234567890123456789012345678901234567890")).toBe(false);
	});

	it("rejects a string that is too short", () => {
		expect(isValidSolanaAddress("abc")).toBe(false);
	});
});
