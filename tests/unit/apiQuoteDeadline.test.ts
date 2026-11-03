import { describe, expect, it } from "bun:test";
import { apiQuoteDeadlineMs } from "../../src/lib/libraries/apiQuote";

describe("apiQuoteDeadlineMs", () => {
  const now = 1_800_000_000_000;

  it("ends at the earliest of validUntil, expires and fillDeadline", () => {
    const order = { expires: 1_800_003_600, fillDeadline: 1_800_003_000 };
    expect(apiQuoteDeadlineMs({ validUntil: 1_800_004_000 }, order, now)).toBe(1_800_003_000_000);
    expect(apiQuoteDeadlineMs({ validUntil: 1_800_000_030 }, order, now)).toBe(1_800_000_030_000);
  });

  it("counts fillDeadline even when it precedes expires", () => {
    // validateApiQuote rejects an elapsed fillDeadline, so the UI must not
    // show the quote as valid past it.
    const order = { expires: 1_800_009_000, fillDeadline: 1_800_000_060 };
    expect(apiQuoteDeadlineMs({}, order, now)).toBe(1_800_000_060_000);
  });

  it("falls back to a 30s window without a decoded order", () => {
    expect(apiQuoteDeadlineMs({}, undefined, now)).toBe(now + 30_000);
    expect(apiQuoteDeadlineMs({ validUntil: 1_800_000_010 }, undefined, now)).toBe(
      1_800_000_010_000
    );
  });
});
