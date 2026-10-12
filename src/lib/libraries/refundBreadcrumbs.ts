// Fast-refund breadcrumbs: tx references from earlier steps, kept so a reload
// resumes without rescanning. HINTS ONLY — every value is re-verified against
// the chain before it is used, so a stale, foreign or tampered entry costs a
// lookup, never funds. Polymer job indexes are deliberately not stored here:
// `/polymer` returns whatever proof an index names, and nothing can check that
// association, so a stored index could make the user submit an unrelated proof.

export type RefundBreadcrumb = {
  v: 1;
  outputIndex: number;
  emitTxHash?: `0x${string}`;
  recordSignature?: string;
};

const keyFor = (orderId: string) => `lintent.refund.v1.${orderId.toLowerCase()}`;

/** The breadcrumb for this order's rail, or undefined when absent, invalid or for another output. */
export function loadBreadcrumb(orderId: string, outputIndex: number): RefundBreadcrumb | undefined {
  try {
    const raw = localStorage.getItem(keyFor(orderId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<RefundBreadcrumb>;
    if (parsed?.v !== 1 || parsed.outputIndex !== outputIndex) return undefined;
    return parsed as RefundBreadcrumb;
  } catch {
    return undefined;
  }
}

export function saveBreadcrumb(
  orderId: string,
  outputIndex: number,
  patch: Partial<Omit<RefundBreadcrumb, "v" | "outputIndex">>
): void {
  try {
    const next: RefundBreadcrumb = {
      ...loadBreadcrumb(orderId, outputIndex),
      ...patch,
      v: 1,
      outputIndex
    };
    localStorage.setItem(keyFor(orderId), JSON.stringify(next));
  } catch {
    // Storage full or disabled: resuming falls back to chain discovery.
  }
}

export function clearBreadcrumb(orderId: string): void {
  try {
    localStorage.removeItem(keyFor(orderId));
  } catch {
    // ignore
  }
}
