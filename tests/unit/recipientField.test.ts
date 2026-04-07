import { describe, expect, it } from "bun:test";
import { isAddress } from "viem";
import { isValidSolanaAddress, solanaAddressToBytes32 } from "../../src/lib/utils/solana";

// Mirrors the resolveRecipient helper in IssueIntent.svelte
const resolveRecipient = (value: string): `0x${string}` | undefined =>
	isAddress(value, { strict: false }) ? (value as `0x${string}`) : undefined;

describe("resolveRecipient", () => {
	it("returns the address for a valid checksummed EVM address", () => {
		const addr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
		expect(resolveRecipient(addr)).toBe(addr);
	});

	it("returns the address for a valid lowercase EVM address (strict: false)", () => {
		const addr = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
		expect(resolveRecipient(addr)).toBe(addr);
	});

	it("returns undefined for an empty string", () => {
		expect(resolveRecipient("")).toBeUndefined();
	});

	it("returns undefined for a partial address", () => {
		expect(resolveRecipient("0x1234")).toBeUndefined();
	});

	it("returns undefined for arbitrary non-address text", () => {
		expect(resolveRecipient("alice.eth")).toBeUndefined();
	});

	it("returns undefined for a hex string that is too long", () => {
		expect(resolveRecipient("0x" + "a".repeat(42))).toBeUndefined();
	});
});

describe("outputRecipient in AppCreateIntentOptions", () => {
	it("is undefined when recipient field is empty", () => {
		const recipient = "";
		const outputRecipient = resolveRecipient(recipient);
		expect(outputRecipient).toBeUndefined();
	});

	it("is set when a valid address is provided", () => {
		const recipient = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
		const outputRecipient = resolveRecipient(recipient);
		expect(outputRecipient).toBe(recipient);
	});

	it("is undefined for an invalid address, so wallet default is used", () => {
		const recipient = "not-an-address";
		const outputRecipient = resolveRecipient(recipient);
		expect(outputRecipient).toBeUndefined();
	});
});

// Known Solana devnet USDC mint and its expected bytes32 encoding
const USDC_DEVNET_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USDC_DEVNET_BYTES32 = "0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7";

describe("isValidSolanaAddress", () => {
	it("returns true for a valid 32-byte base58 pubkey", () => {
		expect(isValidSolanaAddress(USDC_DEVNET_B58)).toBe(true);
	});

	it("returns true for a well-known system program address", () => {
		expect(isValidSolanaAddress("11111111111111111111111111111111")).toBe(true);
	});

	it("returns false for an empty string", () => {
		expect(isValidSolanaAddress("")).toBe(false);
	});

	it("returns false for an EVM address", () => {
		expect(isValidSolanaAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(false);
	});

	it("returns false for invalid base58 characters (0, O, I, l)", () => {
		expect(isValidSolanaAddress("0OIl" + "1".repeat(28))).toBe(false);
	});

	it("returns false for a base58 string that decodes to fewer than 32 bytes", () => {
		expect(isValidSolanaAddress("1111111")).toBe(false);
	});
});

describe("solanaAddressToBytes32", () => {
	it("encodes a known devnet USDC mint to its expected bytes32", () => {
		expect(solanaAddressToBytes32(USDC_DEVNET_B58)).toBe(USDC_DEVNET_BYTES32);
	});

	it("returns a 66-character hex string (0x + 64 hex chars)", () => {
		const result = solanaAddressToBytes32(USDC_DEVNET_B58);
		expect(result).toMatch(/^0x[0-9a-f]{64}$/);
	});

	it("throws for an invalid Solana address", () => {
		expect(() => solanaAddressToBytes32("not-valid")).toThrow();
	});

	it("throws for a base58 string that decodes to fewer than 32 bytes", () => {
		expect(() => solanaAddressToBytes32("1111111")).toThrow();
	});
});
