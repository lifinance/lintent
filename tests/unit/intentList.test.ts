import { describe, expect, it } from "bun:test";
import { inputSettlerForStellar, STELLAR_MAINNET_CHAIN_ID } from "@lifi/intent";
import type { OrderContainer } from "@lifi/intent";
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

  it("builds a Stellar row from an order reloaded from storage", () => {
    const xlm = 0x25b4fcd859aec2fa6348438c489b3c3c10c98b6d21be4fd3cb30cb68953ef977n;
    const container: OrderContainer = {
      inputSettler: inputSettlerForStellar(STELLAR_MAINNET_CHAIN_ID),
      order: {
        user: `0x${"01".repeat(32)}`,
        nonce: 1n,
        originChainId: STELLAR_MAINNET_CHAIN_ID,
        expires: Math.floor(Date.now() / 1000) + 3600,
        fillDeadline: Math.floor(Date.now() / 1000) + 3600,
        inputOracle: "0x2a9746edd91c73f4c63b95ef626f0d0ad40ac6901dba0686f4a5fed64c359048",
        inputs: [[xlm, 10_000_000n]],
        outputs: [
          {
            oracle: "0x000000000000000000000000b7eA767b54aF5Dd8AD12Df648A399F9075D93FeE",
            settler: "0x00000000000000000000000075220B7600c300005038432a0000f308e0000068",
            chainId: 8453n,
            token: "0x000000000000000000000000833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount: 1_000_000n,
            recipient: "0x0000000000000000000000001111111111111111111111111111111111111111",
            callbackData: "0x",
            context: "0x"
          }
        ]
      },
      sponsorSignature: { type: "None", payload: "0x" },
      allocatorSignature: { type: "None", payload: "0x" }
    };
    // Same encoding as Store.saveOrderToDb / loadOrdersFromDb (bigints as decimal strings).
    const reloaded = JSON.parse(
      JSON.stringify(container, (_, v) => (typeof v === "bigint" ? v.toString() : v))
    ) as OrderContainer;

    const row = buildBaseIntentRow(reloaded);

    expect(row.inputChips[0].text).toBe("1.0000 XLM on stellar");
    expect(row.inputSchemeBadge).toBe("Escrow");
    expect(row.orderId).toBe(buildBaseIntentRow(container).orderId);
  });
});
