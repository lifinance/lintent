import { describe, expect, it } from "bun:test";
import { resolveDemoQuoteParams } from "../../src/lib/libraries/demoQuote";

describe("resolveDemoQuoteParams", () => {
  it("never sets exclusiveFor and sends the integrator key in demo mode", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: true,
      integratorKey: "demo-key",
      useExclusiveForQuoteRequest: false,
      exclusiveFor: ""
    });

    expect(result.exclusiveFor).toBeUndefined();
    expect(result.integratorKey).toBe("demo-key");
  });

  it("ignores the manual exclusive field while in demo mode", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: true,
      integratorKey: "demo-key",
      useExclusiveForQuoteRequest: true,
      exclusiveFor: "0x1111111111111111111111111111111111111111"
    });

    expect(result.exclusiveFor).toBeUndefined();
  });

  it("omits the integrator key when none is provided in demo mode", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: true,
      integratorKey: "",
      useExclusiveForQuoteRequest: false,
      exclusiveFor: ""
    });

    expect(result.exclusiveFor).toBeUndefined();
    expect(result.integratorKey).toBeUndefined();
  });

  it("never sends an integrator key when demo mode is off", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: false,
      integratorKey: "demo-key",
      useExclusiveForQuoteRequest: false,
      exclusiveFor: ""
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
      exclusiveFor: addr
    });

    expect(result.exclusiveFor).toEqual([addr]);
  });

  it("filters out an invalid manual exclusive address", () => {
    const result = resolveDemoQuoteParams({
      use11Demo: false,
      integratorKey: "",
      useExclusiveForQuoteRequest: true,
      exclusiveFor: "not-an-address"
    });

    expect(result.exclusiveFor).toEqual([]);
  });
});
