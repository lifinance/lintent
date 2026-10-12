import {
  IntentApi,
  parseOrderStatusPayload,
  isTronBase58Address,
  tronBase58ToHex,
  SOLANA_INPUT_SETTLER_ESCROW_PDA,
  SOLANA_INPUT_SETTLER_ESCROW_PROGRAM,
  SOLANA_MAINNET_CHAIN_ID,
  TRON_LEGACY_INPUT_SETTLERS,
  TRON_MAINNET_CHAIN_ID,
  TRON_MAINNET_INPUT_SETTLER
} from "@lifi/intent";
import type { OrderContainer, StandardOrder } from "@lifi/intent";
import { base58 } from "@scure/base";
import { bytesToHex, getAbiItem, toEventSelector } from "viem";
import {
  chainMetaById,
  getChainName,
  getClient,
  INPUT_SETTLER_COMPACT_LIFI,
  INPUT_SETTLER_ESCROW_LIFI,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  MULTICHAIN_INPUT_SETTLER_ESCROW
} from "$lib/config";
import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";
import { TRON_INPUT_SETTLER_ABI } from "$lib/abi/tron";
import { containerToIntent } from "$lib/utils/intent";
import { getChainType } from "$lib/utils/chainType";
import type { TxRef } from "$lib/utils/txRef";
import { INPUT_SETTLER_ESCROW_PROGRAM_ID } from "$lib/idl";
import { OPEN_DISCRIMINATOR, programDataLogs } from "$lib/solana/events";
import { getSolanaReads } from "$lib/solana/client";
import { getTronReads } from "$lib/tron/client";
import { getTronTransactionInfo } from "$lib/tron/reads";

/**
 * Mainnet chains this page can read and write: lintent's own registry. An order
 * touching anything else renders status only (adding chains is `add-chain`).
 */
export const REFUND_CHAIN_IDS: readonly number[] = Object.values(chainMetaById)
  .filter((meta) => !meta.testnet)
  .map((meta) => meta.id);

export type UnsupportedReason =
  | "multichain"
  | "compact"
  | "unknown-settler"
  | "unsupported-chain"
  | "orderid-mismatch";

/** order.li.fi hints. Advisory only: the chain decides everything except a Delivered block. */
export type RefundOrderMeta = {
  onChainOrderId: string | null;
  orderStatus: string | null;
  orderInitiatedTxHash: string | null;
  orderDeliveredTxHash: string | null;
  orderSettledTxHash: string | null;
  refundTxHash: string | null;
};

export type RefundOrder = {
  orderId: `0x${string}`;
  container: OrderContainer;
  /** The single-origin order, or null for multichain (always `unsupported`). */
  order: StandardOrder | null;
  meta: RefundOrderMeta;
  unsupported?: UnsupportedReason;
  /** Tron pre-2026-08 settler: slow refund only. */
  legacySettler: boolean;
  resolvedFrom?: { chainId: number; txRef: TxRef };
};

/** An order this page may act on: escrow, StandardOrder, every chain known. */
export type EscrowRefundOrder = RefundOrder & { order: StandardOrder; unsupported?: undefined };

export function isEscrowRefundOrder(order: RefundOrder): order is EscrowRefundOrder {
  return order.order !== null && order.unsupported === undefined;
}

export type RefundInput =
  | { kind: "hex32"; value: `0x${string}` }
  | { kind: "solana-signature"; value: string };

const INPUT_ERROR = "Enter an order id (0x…, 32 bytes) or the transaction that opened the order.";

export function parseRefundInput(raw: string): RefundInput | { error: string } {
  const value = raw.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return { kind: "hex32", value: value.toLowerCase() as `0x${string}` };
  }
  // A bare 64-hex string is how TronScan shows a transaction id.
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return { kind: "hex32", value: `0x${value.toLowerCase()}` };
  }
  try {
    if (base58.decode(value).length === 64) return { kind: "solana-signature", value };
  } catch {
    // not base58
  }
  return { error: INPUT_ERROR };
}

function envelopeOf(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = "data" in root ? root.data : root;
  const candidate = Array.isArray(data) ? data[0] : data;
  if (!candidate || typeof candidate !== "object") return undefined;
  const c = candidate as Record<string, unknown>;
  return c.intent && typeof c.intent === "object" ? (c.intent as Record<string, unknown>) : c;
}

/**
 * The order API renders a Tron-origin order's `user`, `inputOracle` and
 * `inputSettler` as Tron base58. `parseOrderStatusPayload` reads every non-`0x`
 * address as Solana base58 and throws on them, so convert those three to hex
 * first. Output fields are always bytes32 hex. Returns a deep copy.
 */
export function normalizeOrderPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const copy = structuredClone(payload) as Record<string, unknown>;
  const envelope = envelopeOf(copy);
  const order = envelope?.order as Record<string, unknown> | undefined;
  if (!envelope || !order || String(order.originChainId) !== TRON_MAINNET_CHAIN_ID.toString()) {
    return copy;
  }
  const toHex = (value: unknown) =>
    typeof value === "string" && isTronBase58Address(value) ? tronBase58ToHex(value) : value;
  order.user = toHex(order.user);
  order.inputOracle = toHex(order.inputOracle);
  envelope.inputSettler = toHex(envelope.inputSettler);
  return copy;
}

export function extractOrderMeta(payload: unknown): RefundOrderMeta {
  const envelope =
    payload && typeof payload === "object"
      ? envelopeOf(payload as Record<string, unknown>)
      : undefined;
  const raw = (envelope?.meta ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : null);
  return {
    onChainOrderId: str("onChainOrderId"),
    orderStatus: str("orderStatus"),
    orderInitiatedTxHash: str("orderInitiatedTxHash"),
    orderDeliveredTxHash: str("orderDeliveredTxHash"),
    orderSettledTxHash: str("orderSettledTxHash"),
    refundTxHash: str("refundTxHash")
  };
}

export type FetchedOrder = { container: OrderContainer; meta: RefundOrderMeta };

/**
 * `GET /orders/status/?onChainOrderId=` with the `meta` block kept
 * (`IntentApi.getOrderByOnChainOrderId` drops it). Null on 404.
 */
export async function fetchRefundOrder(
  orderId: `0x${string}`,
  fetchFn: typeof fetch = fetch
): Promise<FetchedOrder | null> {
  const url = new URL("/orders/status/", IntentApi.getIntentApiUrl(true));
  url.searchParams.set("onChainOrderId", orderId);
  const response = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`order.li.fi is unavailable (${response.status}). Try again.`);
  }
  const json = (await response.json()) as unknown;
  return {
    container: parseOrderStatusPayload(normalizeOrderPayload(json)),
    meta: extractOrderMeta(json)
  };
}

const lower = (value: string) => value.toLowerCase();

/** Which settler family the order uses, plus the order-id integrity check (plan §5.1). */
export function classifyOrder(fetched: FetchedOrder, requestedId: `0x${string}`): RefundOrder {
  const { container, meta } = fetched;
  const base = { container, meta, legacySettler: false };
  if (!("originChainId" in container.order)) {
    return { ...base, orderId: requestedId, order: null, unsupported: "multichain" };
  }
  const order = container.order;
  const orderId = containerToIntent(container).orderId();
  const settler = lower(container.inputSettler);
  const origin = order.originChainId;
  const classify = (): Pick<RefundOrder, "unsupported" | "legacySettler"> => {
    if (orderId !== requestedId || lower(meta.onChainOrderId ?? orderId) !== orderId) {
      return { unsupported: "orderid-mismatch", legacySettler: false };
    }
    if (!REFUND_CHAIN_IDS.includes(Number(origin))) {
      return { unsupported: "unsupported-chain", legacySettler: false };
    }
    switch (getChainType(origin)) {
      case "tron": {
        if (settler === lower(TRON_MAINNET_INPUT_SETTLER)) return { legacySettler: false };
        const legacy = TRON_LEGACY_INPUT_SETTLERS[origin.toString()] ?? [];
        if (legacy.some((address) => lower(address) === settler)) return { legacySettler: true };
        return { unsupported: "unknown-settler", legacySettler: false };
      }
      case "solana":
        return settler === lower(SOLANA_INPUT_SETTLER_ESCROW_PROGRAM) ||
          settler === lower(SOLANA_INPUT_SETTLER_ESCROW_PDA)
          ? { legacySettler: false }
          : { unsupported: "unknown-settler", legacySettler: false };
      case "evm":
        if (settler === lower(INPUT_SETTLER_ESCROW_LIFI)) return { legacySettler: false };
        if (settler === lower(INPUT_SETTLER_COMPACT_LIFI)) {
          return { unsupported: "compact", legacySettler: false };
        }
        if (
          settler === lower(MULTICHAIN_INPUT_SETTLER_ESCROW) ||
          settler === lower(MULTICHAIN_INPUT_SETTLER_COMPACT)
        ) {
          return { unsupported: "multichain", legacySettler: false };
        }
        return { unsupported: "unknown-settler", legacySettler: false };
    }
  };
  return { ...base, orderId, order, ...classify() };
}

// Both escrow `Open` shapes put the order id in topics[1]: the full
// `Open(bytes32 indexed, StandardOrder)` and the gas-lite `Open(bytes32 indexed)`
// that `openForAndFinalise` emits.
const OPEN_TOPICS: ReadonlySet<string> = new Set([
  toEventSelector(getAbiItem({ abi: SETTLER_ESCROW_ABI, name: "Open" })),
  toEventSelector("Open(bytes32)"),
  ...TRON_INPUT_SETTLER_ABI.filter(
    (item): item is Extract<(typeof TRON_INPUT_SETTLER_ABI)[number], { type: "event" }> =>
      item.type === "event" && item.name === "Open"
  ).map((item) => toEventSelector(item))
]);

const TRON_ESCROW_SETTLERS: ReadonlySet<string> = new Set(
  [
    TRON_MAINNET_INPUT_SETTLER,
    ...(TRON_LEGACY_INPUT_SETTLERS[TRON_MAINNET_CHAIN_ID.toString()] ?? [])
  ].map(lower)
);

/** Order ids an open-tx probe found on one chain; null when the tx isn't there. */
type ProbeHit = { chainId: number; orderIds: `0x${string}`[] };

async function probeEvm(chainId: number, hash: `0x${string}`): Promise<ProbeHit | null> {
  const receipt = await getClient(chainId).getTransactionReceipt({ hash });
  const settler = lower(INPUT_SETTLER_ESCROW_LIFI);
  const orderIds = receipt.logs
    .filter(
      (log) =>
        lower(log.address) === settler &&
        log.topics[0] !== undefined &&
        OPEN_TOPICS.has(lower(log.topics[0])) &&
        log.topics[1] !== undefined
    )
    .map((log) => lower(log.topics[1]!) as `0x${string}`);
  return { chainId, orderIds };
}

async function probeTron(hash: `0x${string}`): Promise<ProbeHit | null> {
  const info = await getTronTransactionInfo(await getTronReads(), hash);
  // TronGrid answers `{}` for an unknown id rather than erroring.
  if (!info.id) return null;
  const orderIds = (info.log ?? [])
    .filter(
      (log) =>
        TRON_ESCROW_SETTLERS.has(lower(`0x${log.address}`)) &&
        log.topics[0] !== undefined &&
        OPEN_TOPICS.has(lower(`0x${log.topics[0]}`)) &&
        log.topics[1] !== undefined
    )
    .map((log) => lower(`0x${log.topics[1]}`) as `0x${string}`);
  return { chainId: Number(TRON_MAINNET_CHAIN_ID), orderIds };
}

async function probeSolana(signature: string): Promise<ProbeHit | null> {
  const reads = await getSolanaReads(SOLANA_MAINNET_CHAIN_ID);
  const tx = await reads.getTransaction(signature);
  if (!tx) return null;
  const orderIds = programDataLogs(tx.meta?.logMessages ?? [], INPUT_SETTLER_ESCROW_PROGRAM_ID)
    .filter(
      (payload) =>
        payload.length >= 40 && OPEN_DISCRIMINATOR.every((byte, i) => payload[i] === byte)
    )
    .map((payload) => bytesToHex(payload.subarray(8, 40)));
  return { chainId: Number(SOLANA_MAINNET_CHAIN_ID), orderIds };
}

export type ResolvedOpenTx = { orderId: `0x${string}`; chainId: number; txRef: TxRef };

/** Finds the escrow order an opening transaction created, on any supported mainnet. */
export async function resolveOrderIdFromOpenTx(input: RefundInput): Promise<ResolvedOpenTx> {
  const probes: Promise<ProbeHit | null>[] =
    input.kind === "solana-signature"
      ? [probeSolana(input.value)]
      : REFUND_CHAIN_IDS.filter((id) => getChainType(id) !== "solana").map((id) =>
          getChainType(id) === "tron" ? probeTron(input.value) : probeEvm(id, input.value)
        );
  // A probe failing (tx not on that chain, RPC hiccup) only rules that chain out.
  const settled = await Promise.allSettled(probes);
  const hits = settled.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );
  if (hits.length === 0) {
    throw new Error("No order or opening transaction found on supported mainnets.");
  }
  const found = hits.flatMap((hit) =>
    hit.orderIds.map((orderId) => ({ orderId, chainId: hit.chainId }))
  );
  const distinct = [...new Set(found.map((entry) => entry.orderId))];
  if (distinct.length === 0) {
    throw new Error(
      `Transaction found on ${getChainName(hits[0]!.chainId)} but it didn't open an escrow order.`
    );
  }
  if (distinct.length > 1) {
    throw new Error("This transaction opened several orders. Paste the order id instead.");
  }
  return { orderId: distinct[0]!, chainId: found[0]!.chainId, txRef: input.value };
}

/** Raw input → classified order (plan §6). Throws with user-facing copy. */
export async function lookupRefundOrder(
  raw: string,
  fetchFn: typeof fetch = fetch
): Promise<RefundOrder> {
  const input = parseRefundInput(raw);
  if ("error" in input) throw new Error(input.error);
  if (input.kind === "hex32") {
    const direct = await fetchRefundOrder(input.value, fetchFn);
    if (direct) return classifyOrder(direct, input.value);
  }
  const resolved = await resolveOrderIdFromOpenTx(input);
  const fetched = await fetchRefundOrder(resolved.orderId, fetchFn);
  if (!fetched) {
    throw new Error(
      `Order ${resolved.orderId} opened on ${getChainName(resolved.chainId)} but isn't indexed by order.li.fi yet. Try again later.`
    );
  }
  return {
    ...classifyOrder(fetched, resolved.orderId),
    resolvedFrom: { chainId: resolved.chainId, txRef: resolved.txRef }
  };
}
