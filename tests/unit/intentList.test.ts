import { describe, expect, it } from "bun:test";
import {
  buildBaseIntentRow,
  EXPIRING_THRESHOLD_SECONDS,
  compareActiveRows,
  compareExpiredRows,
  formatRelativeDeadline,
  formatRemaining,
  withTiming,
  type BaseIntentRow
} from "../../src/lib/libraries/intentList";

const baseRow: BaseIntentRow = {
  orderContainer: {
    inputSettler: "0x00fC00edbe7C003b006f870068c548940000223e",
    order: {
      user: "0x1111111111111111111111111111111111111111",
      nonce: 1n,
      originChainId: 8453n,
      expires: Math.floor(Date.now() / 1000) + 3600,
      fillDeadline: Math.floor(Date.now() / 1000) + 3600,
      inputOracle: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
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
      inputSettler: "0x00fC00edbe7C003b006f870068c548940000223e",
      order: {
        user: "0x1111111111111111111111111111111111111111",
        nonce: 1n,
        originChainId: unknownChainId,
        expires: Math.floor(Date.now() / 1000) + 3600,
        fillDeadline: Math.floor(Date.now() / 1000) + 3600,
        inputOracle: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
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

describe("intentList sort comparators", () => {
  const row = (submitTime: number | undefined, fillDeadline: number): BaseIntentRow => ({
    ...baseRow,
    submitTime,
    fillDeadline
  });

  it("sorts the most recent submit time first (active)", () => {
    const rows = [row(100, 10), row(300, 10), row(200, 10)];
    rows.sort(compareActiveRows);
    expect(rows.map((r) => r.submitTime)).toEqual([300, 200, 100]);
  });

  it("sorts the most recent submit time first (expired)", () => {
    const rows = [row(100, 10), row(300, 10), row(200, 10)];
    rows.sort(compareExpiredRows);
    expect(rows.map((r) => r.submitTime)).toEqual([300, 200, 100]);
  });

  it("breaks submit-time ties by fillDeadline (active: soonest first)", () => {
    const rows = [row(100, 30), row(100, 10), row(100, 20)];
    rows.sort(compareActiveRows);
    expect(rows.map((r) => r.fillDeadline)).toEqual([10, 20, 30]);
  });

  it("breaks submit-time ties by fillDeadline (expired: latest first)", () => {
    const rows = [row(100, 10), row(100, 30), row(100, 20)];
    rows.sort(compareExpiredRows);
    expect(rows.map((r) => r.fillDeadline)).toEqual([30, 20, 10]);
  });

  it("sorts rows without a submit time last", () => {
    const rows = [row(undefined, 10), row(50, 10), row(undefined, 5)];
    rows.sort(compareActiveRows);
    expect(rows[0].submitTime).toBe(50);
    expect(rows.slice(1).every((r) => r.submitTime === undefined)).toBe(true);
  });
});
