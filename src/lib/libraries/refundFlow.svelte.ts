// Rune-based controller for the /refund page: lookup, periodic chain refresh,
// and the refund actions. The view is always derived from the latest chain
// snapshot — actions never advance it directly, they refresh.

import type { TxRef } from "$lib/utils/txRef";
import { encodeNotFilledDescription } from "@lifi/intent";
import { clearWormholeHint } from "./wormholeProof";
import { oracleProviderFor } from "./oracleRoute";
import {
  describeActionError,
  fetchNonFillProof,
  submitFastRefund,
  submitNonFillProof,
  submitNonFillRecord,
  submitSlowRefund
} from "./refundActions";
import { clearBreadcrumb } from "./refundBreadcrumbs";
import {
  isEscrowRefundOrder,
  lookupRefundOrder,
  type EscrowRefundOrder,
  type RefundOrder
} from "./refundLookup";
import { readRefundSnapshot } from "./refundReads";
import {
  deriveRefundView,
  SOLANA_SAMECHAIN_REFUND_GRACE_SECS,
  type FastRail,
  type RefundSnapshot
} from "./refundState";

export type RefundAction = "slow" | "record" | "prove" | "fast";
export type ProofStatus = null | { attempt: number; total: number } | "not-ready";

const AUTO_REFRESH_MS = 30_000;
/** Seconds past a deadline before re-reading, so the chain clock has caught up. */
const THRESHOLD_SLACK_SECS = 5;

const nowSecs = () => Math.floor(Date.now() / 1000);

export class RefundFlow {
  input = $state("");
  lookupError = $state<string | null>(null);
  order = $state.raw<RefundOrder | null>(null);
  snapshot = $state.raw<RefundSnapshot | null>(null);
  readError = $state<string | null>(null);
  now = $state(nowSecs());
  busy = $state<null | "lookup" | RefundAction>(null);
  refreshing = $state(false);
  actionError = $state<string | null>(null);
  proofStatus = $state<ProofStatus>(null);
  proofStage = $state<string | null>(null);
  lastTx = $state<Partial<Record<RefundAction, TxRef>>>({});

  view = $derived(this.order ? deriveRefundView(this.order, this.snapshot, this.now) : null);

  #onInput?: (raw: string) => void;
  // Drops results of a refresh superseded by a newer one.
  #refreshSeq = 0;

  constructor(opts: { onInput?: (raw: string) => void } = {}) {
    this.#onInput = opts.onInput;
  }

  /**
   * Refused while any lookup or action runs: replacing the order mid-action
   * would let the action's result and lock release land on the new order.
   */
  async lookup(raw: string) {
    if (this.busy) return;
    this.input = raw.trim();
    this.lookupError = null;
    this.busy = "lookup";
    ++this.#refreshSeq;
    this.refreshing = false;
    try {
      const order = await lookupRefundOrder(this.input);
      this.order = order;
      this.snapshot = null;
      this.readError = null;
      this.actionError = null;
      this.proofStatus = null;
      this.proofStage = null;
      this.lastTx = {};
      this.#onInput?.(this.input);
    } catch (error) {
      this.lookupError = error instanceof Error ? error.message : String(error);
      return;
    } finally {
      this.busy = null;
    }
    await this.refresh();
  }

  /** Re-reads chain state. Keeps the previous snapshot when a read fails. */
  async refresh() {
    const order = this.order;
    if (!order || !isEscrowRefundOrder(order)) return;
    const seq = ++this.#refreshSeq;
    this.refreshing = true;
    try {
      const snapshot = await readRefundSnapshot(order, nowSecs());
      if (seq !== this.#refreshSeq || this.order !== order) return;
      this.snapshot = snapshot;
      this.readError = null;
      const kind = this.view?.kind;
      if (
        kind === "refunded" ||
        kind === "claimed" ||
        order.meta.orderStatus === "Delivered" ||
        order.meta.orderStatus === "Settled" ||
        order.meta.orderDeliveredTxHash ||
        order.meta.orderSettledTxHash
      ) {
        clearBreadcrumb(order.orderId);
        this.proofStatus = null;
        this.proofStage = null;
        if (oracleProviderFor(order.order.originChainId, order.order.inputOracle) === "wormhole") {
          for (const output of order.order.outputs) {
            clearWormholeHint(output, {
              application: output.settler,
              payload: encodeNotFilledDescription({
                orderId: order.orderId,
                output,
                fillDeadline: order.order.fillDeadline
              })
            });
          }
        }
      }
    } catch (error) {
      if (seq !== this.#refreshSeq || this.order !== order) return;
      console.warn("refund refresh failed", error);
      this.readError = error instanceof Error ? error.message : String(error);
    } finally {
      if (seq === this.#refreshSeq) this.refreshing = false;
    }
  }

  get #fastRail(): FastRail | null {
    return this.view?.kind === "fast" ? this.view.rail : null;
  }

  async #run(
    action: RefundAction,
    body: (order: EscrowRefundOrder) => Promise<TxRef | null | void>
  ) {
    const order = this.order;
    if (this.busy || this.refreshing || this.readError || !order || !isEscrowRefundOrder(order))
      return;
    this.busy = action;
    this.actionError = null;
    this.proofStage = null;
    if (action !== "prove") this.proofStatus = null;
    try {
      const tx = await body(order);
      if (tx) this.lastTx = { ...this.lastTx, [action]: tx };
      if (this.proofStatus !== "not-ready") this.proofStage = null;
    } catch (error) {
      this.actionError = describeActionError(error);
    } finally {
      this.busy = null;
    }
    await this.refresh();
  }

  runSlowRefund() {
    return this.#run("slow", submitSlowRefund);
  }

  runRecord() {
    const rail = this.#fastRail;
    if (!rail) return;
    return this.#run("record", (order) => submitNonFillRecord(order, rail));
  }

  runProve() {
    const rail = this.#fastRail;
    const fast = this.snapshot?.fast;
    const source = fast && "rail" in fast ? fast.source : null;
    if (!rail || !source) return;
    return this.#run("prove", async (order) => {
      this.proofStatus = null;
      if (rail.provider === "wormhole") this.proofStage = "Waiting for Wormhole guardians";
      const result = await fetchNonFillProof(order, rail, source, (attempt, total) => {
        this.proofStatus = { attempt, total };
      });
      if (result.status === "pending") {
        this.proofStatus = "not-ready";
        return;
      }
      this.proofStatus = null;
      if (result.status === "attested") return;
      return submitNonFillProof(order, rail, result.proof, source, (stage) => {
        this.proofStage = stage;
      });
    });
  }

  runFastRefund() {
    const rail = this.#fastRail;
    if (!rail) return;
    return this.#run("fast", (order) => submitFastRefund(order, rail));
  }

  /** Starts the clock and auto-refresh; returns the teardown for `onMount`. */
  start(): () => void {
    let lastAuto = Date.now();
    const ticker = setInterval(() => {
      const previous = this.now;
      this.now = nowSecs();
      const order = this.order?.order;
      if (!order) return;
      const thresholds = [
        order.fillDeadline + THRESHOLD_SLACK_SECS,
        order.expires + THRESHOLD_SLACK_SECS,
        order.expires + SOLANA_SAMECHAIN_REFUND_GRACE_SECS + THRESHOLD_SLACK_SECS
      ];
      const crossed = thresholds.some((t) => previous < t && this.now >= t);
      const kind = this.view?.kind;
      const live = kind === "fast" || kind?.startsWith("waiting-");
      const due = live && Date.now() - lastAuto >= AUTO_REFRESH_MS;
      if ((crossed || due) && this.busy === null && !this.refreshing) {
        lastAuto = Date.now();
        void this.refresh();
      }
    }, 1000);
    return () => clearInterval(ticker);
  }
}
