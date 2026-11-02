import { describe, expect, it } from "bun:test";
import { resolveDemoQuoteParams } from "../../src/lib/libraries/demoQuote";

describe("resolveDemoQuoteParams", () => {
  it("never sets exclusiveFor and sends the integrator key in demo mode", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: true,
      integratorKey: "demo-key",
      useExclusiveForQuoteRequest: false,
      exclusiveFor: "",
      inputChainType: "evm"
    });

    expect(result.exclusiveFor).toBeUndefined();
    expect(result.integratorKey).toBe("demo-key");
  });

  it("ignores the manual exclusive field while in demo mode", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: true,
      integratorKey: "demo-key",
      useExclusiveForQuoteRequest: true,
      exclusiveFor: "0x1111111111111111111111111111111111111111",
      inputChainType: "evm"
    });

    expect(result.exclusiveFor).toBeUndefined();
  });

  it("omits the integrator key when none is provided in demo mode", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: true,
      integratorKey: "",
      useExclusiveForQuoteRequest: false,
      exclusiveFor: "",
      inputChainType: "evm"
    });

    expect(result.exclusiveFor).toBeUndefined();
    expect(result.integratorKey).toBeUndefined();
  });

  it("never sends an integrator key when demo mode is off", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: false,
      integratorKey: "demo-key",
      useExclusiveForQuoteRequest: false,
      exclusiveFor: "",
      inputChainType: "evm"
    });

    expect(result.integratorKey).toBeUndefined();
    expect(result.exclusiveFor).toBeUndefined();
  });

  it("uses the manual exclusive address when locked and not in demo mode", () => {
    const addr = "0x1111111111111111111111111111111111111111";
    const result = resolveDemoQuoteParams({
      use11Demo: false,
      integratorKey: "",
      useExclusiveForQuoteRequest: true,
      exclusiveFor: addr,
      inputChainType: "evm"
    });

    expect(result.exclusiveFor).toEqual([addr]);
  });

  it("filters out an invalid manual exclusive address", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: false,
      integratorKey: "",
      useExclusiveForQuoteRequest: true,
      exclusiveFor: "not-an-address",
      inputChainType: "evm"
    });

    expect(result.exclusiveFor).toEqual([]);
  });

  // The solver identity has to be one the INPUT settler can pay out to: the
  // order service normalizes metadata.exclusiveFor against the quote's origin
  // chain, so a 0x address on a Solana-origin request matches no solver at all.
  it("keeps a base58 solver on a Solana-origin request, as the internal 32-byte form", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: false,
      integratorKey: "",
      useExclusiveForQuoteRequest: true,
      exclusiveFor: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      inputChainType: "solana"
    });

    expect(result.exclusiveFor).toEqual([
      "0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7"
    ]);
  });

  it("drops an EVM solver on a Solana-origin request", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: false,
      integratorKey: "",
      useExclusiveForQuoteRequest: true,
      exclusiveFor: "0x7bb2b9b2cf209b88850cb744d9e38297905549c9",
      inputChainType: "solana"
    });

    expect(result.exclusiveFor).toEqual([]);
  });

  it("drops a Solana solver on an EVM-origin request", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: false,
      integratorKey: "",
      useExclusiveForQuoteRequest: true,
      exclusiveFor: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      inputChainType: "evm"
    });

    expect(result.exclusiveFor).toEqual([]);
  });
});
