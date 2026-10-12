import { describe, expect, mock, test } from "bun:test";
import { parseOrderStatusPayload } from "@lifi/intent";
import type { FetchedOrder } from "../../src/lib/libraries/refundLookup";

// The module's open-tx probes import the Tron/Solana clients, which read
// SvelteKit's `$app/environment`; bun can't resolve it, so stub it first.
mock.module("$app/environment", () => ({ browser: false }));
const {
  classifyOrder,
  extractOrderMeta,
  fetchRefundOrder,
  normalizeOrderPayload,
  parseRefundInput
} = await import("../../src/lib/libraries/refundLookup");
import { containerToIntent } from "../../src/lib/utils/intent";
import evmRefunded from "../fixtures/refund/evm-refunded.json";
import tronOpen from "../fixtures/refund/tron-origin-open.json";
import solanaSettled from "../fixtures/refund/solana-origin-settled.json";

const EVM_ID = "0x32635326120226d9d702e7c69cb49390587f19003ac7fd1120634b49a275657b";
const TRON_ID = "0x389de4ee2d87cfa5e0a5b2770e3c5263df5394fa72653ed7eba4d8010a2a7781";
const SOLANA_ID = "0xd28205b4448fabb5fb39c306d25eaed78ed039bc86d2691750c767a49d0df9c3";

const fetched = (json: unknown): FetchedOrder => ({
  container: parseOrderStatusPayload(normalizeOrderPayload(json)),
  meta: extractOrderMeta(json)
});

describe("parseRefundInput", () => {
  test("0x-prefixed 32 bytes is lower-cased", () => {
    expect(parseRefundInput(`  ${EVM_ID.toUpperCase().replace("0X", "0x")} `)).toEqual({
      kind: "hex32",
      value: EVM_ID
    });
  });

  test("bare 64-hex (Tron tx id) gains the 0x prefix", () => {
    expect(parseRefundInput(TRON_ID.slice(2))).toEqual({ kind: "hex32", value: TRON_ID });
  });

  test("a 64-byte base58 string is a Solana signature", () => {
    const sig =
      "5EAFBSPDkwfaTRhhDWEFauwYfaviW38PTBrcjZiSAosdSpQQ9Zi1HLE5yrXrFRMNiUTxhrdB1PjRMCyymFRstFBq";
    expect(parseRefundInput(sig)).toEqual({ kind: "solana-signature", value: sig });
  });

  test("rejects anything else", () => {
    for (const bad of ["hello", "0x1234", `${EVM_ID}00`, "TUQvKfWye24e3LyrSCamvWwwPnoUoPAuk9"]) {
      expect(parseRefundInput(bad)).toHaveProperty("error");
    }
  });
});

describe("normalizeOrderPayload", () => {
  test("the raw Tron payload does not parse, the normalized one does", () => {
    expect(() => parseOrderStatusPayload(tronOpen)).toThrow("Order payload invalid");
    const container = parseOrderStatusPayload(normalizeOrderPayload(tronOpen));
    expect(container.inputSettler).toBe("0xaa2e58aa1a4107dc8cc7ef41b97be90b25b5b842");
    expect(containerToIntent(container).orderId()).toBe(TRON_ID);
  });

  test("does not mutate its input", () => {
    const before = JSON.stringify(tronOpen);
    normalizeOrderPayload(tronOpen);
    expect(JSON.stringify(tronOpen)).toBe(before);
  });

  test("EVM and Solana orders recompute to their ids", () => {
    expect(containerToIntent(fetched(evmRefunded).container).orderId()).toBe(EVM_ID);
    expect(containerToIntent(fetched(solanaSettled).container).orderId()).toBe(SOLANA_ID);
  });
});

describe("classifyOrder", () => {
  test("current escrow settlers on all three VMs are supported", () => {
    for (const [json, id] of [
      [evmRefunded, EVM_ID],
      [tronOpen, TRON_ID],
      [solanaSettled, SOLANA_ID]
    ] as const) {
      const order = classifyOrder(fetched(json), id);
      expect(order.unsupported).toBeUndefined();
      expect(order.legacySettler).toBe(false);
      expect(order.orderId).toBe(id);
    }
  });

  test("an order that doesn't hash to the requested id is refused", () => {
    expect(classifyOrder(fetched(evmRefunded), TRON_ID).unsupported).toBe("orderid-mismatch");
  });

  test("an order whose meta id disagrees is refused", () => {
    const f = fetched(evmRefunded);
    f.meta.onChainOrderId = TRON_ID;
    expect(classifyOrder(f, EVM_ID).unsupported).toBe("orderid-mismatch");
  });

  // The settler and origin chain are hashed into the order id, so a mutated
  // fixture is re-keyed (requested id and meta id) to its recomputed id.
  const classifyMutated = (json: unknown) => {
    const f = fetched(json);
    const id = containerToIntent(f.container).orderId();
    f.meta.onChainOrderId = id;
    return classifyOrder(f, id);
  };

  test("compact and unknown EVM settlers", () => {
    const withSettler = (settler: string) => {
      const json = structuredClone(evmRefunded) as Record<string, unknown>;
      json.inputSettler = settler;
      return classifyMutated(json).unsupported;
    };
    expect(withSettler("0x0000000000cd5f7fDEc90a03a31F79E5Fbc6A9Cf")).toBe("compact");
    expect(withSettler("0x000001bf3f3175bd007f3889b50000c7006e72c0")).toBe("unknown-settler");
  });

  test("Tron legacy settler is escrow with fast disabled", () => {
    const json = structuredClone(tronOpen) as Record<string, unknown>;
    json.inputSettler = "TXmVLCXzrhzmeCfchDPTmFF6Qe7rg3H7Kk";
    const order = classifyMutated(json);
    expect(order.unsupported).toBeUndefined();
    expect(order.legacySettler).toBe(true);
  });

  test("an origin outside lintent's registry is unsupported-chain", () => {
    const json = structuredClone(evmRefunded) as { order: Record<string, unknown> };
    json.order.originChainId = "130";
    expect(classifyMutated(json).unsupported).toBe("unsupported-chain");
  });
});

describe("fetchRefundOrder", () => {
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("200 keeps meta hints", async () => {
    const result = await fetchRefundOrder(EVM_ID, respond(200, evmRefunded));
    expect(result?.meta.orderStatus).toBe("Refunded");
    expect(result?.meta.refundTxHash).toStartWith("0x42269a00");
  });

  test("404 is null", async () => {
    expect(await fetchRefundOrder(EVM_ID, respond(404, {}))).toBeNull();
  });

  test("5xx throws with the status", async () => {
    expect(fetchRefundOrder(EVM_ID, respond(503, {}))).rejects.toThrow("(503)");
  });
});
