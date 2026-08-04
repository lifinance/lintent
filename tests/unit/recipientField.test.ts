import { describe, expect, it } from "bun:test";
import { resolveAddress as resolveRecipient } from "../../src/lib/utils/address";

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

describe("resolveRecipient (tron)", () => {
  it("resolves a valid Tron Base58Check address to hex", () => {
    expect(resolveRecipient("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(
      "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c"
    );
  });

  it("rejects a Tron address with a single-character typo (checksum)", () => {
    expect(resolveRecipient("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toBeUndefined();
  });
});
