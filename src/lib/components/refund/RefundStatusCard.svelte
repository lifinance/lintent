<script lang="ts">
  import SectionCard from "$lib/components/ui/SectionCard.svelte";
  import type { RefundFlow } from "$lib/libraries/refundFlow.svelte";
  import { buildBaseIntentRow, formatRelativeDeadline } from "$lib/libraries/intentList";
  import {
    chainLabel,
    type FastUnavailableReason,
    type RefundView
  } from "$lib/libraries/refundState";
  import { formatAddressForChain } from "$lib/utils/chainType";
  import { copyToClipboard } from "$lib/utils/clipboard";

  let { flow }: { flow: RefundFlow } = $props();

  const order = $derived(flow.order!);
  const standard = $derived(order.order);
  const view = $derived(flow.view);
  const row = $derived.by(() => {
    try {
      return buildBaseIntentRow(order.container);
    } catch {
      return null;
    }
  });
  const originChainId = $derived(standard ? standard.originChainId : null);
  const outputs = $derived(order.container.order.outputs);
  const destChainIds = $derived([...new Set(outputs.map((output) => output.chainId))]);

  const BADGE: Record<string, { text: string; tone: "green" | "amber" | "gray" | "rose" }> = {
    unsupported: { text: "Not refundable here", tone: "gray" },
    "not-opened": { text: "Not opened", tone: "gray" },
    refunded: { text: "Refunded", tone: "green" },
    claimed: { text: "Claimed", tone: "gray" },
    settled: { text: "Settled", tone: "gray" },
    filled: { text: "Filled", tone: "rose" },
    "fill-unverifiable": { text: "Not refundable here", tone: "gray" },
    slow: { text: "Refundable now", tone: "green" },
    "waiting-expiry": { text: "Waiting", tone: "amber" },
    "waiting-fill-deadline": { text: "Waiting", tone: "amber" }
  };
  const TONE_CLASS = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    gray: "border-gray-200 bg-gray-50 text-gray-600",
    rose: "border-rose-200 bg-rose-50 text-rose-700"
  };

  const badge = $derived.by(() => {
    if (!view) return null;
    if (view.kind === "fast") {
      return view.step === "record"
        ? { text: "Fast refund available", tone: "green" as const }
        : { text: "Fast refund in progress", tone: "amber" as const };
    }
    return BADGE[view.kind]!;
  });

  const at = (secs: number) =>
    `${new Date(secs * 1000).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    })} (${formatRelativeDeadline(secs - flow.now)})`;

  const user = $derived(
    originChainId !== null
      ? formatAddressForChain(order.container.order.user, originChainId)
      : order.container.order.user
  );

  function reasonLine(reason: FastUnavailableReason | null): string {
    const dest = destChainIds
      .filter((id) => id !== originChainId)
      .map(chainLabel)
      .join(", ");
    switch (reason) {
      case null:
        return "";
      case "same-chain":
        return "Same-chain order: refundable after expiry.";
      case "solana-to-solana":
        return "Solana → Solana orders can only be refunded after expiry.";
      case "unsupported-input-oracle":
      case "no-provable-output":
        return "This order's oracle can't prove a non-fill.";
      case "legacy-settler":
        return "Older Tron settler: refundable after expiry.";
      case "chain-map-missing":
        return `The origin oracle can't accept proofs from ${dest} yet.`;
      case "settler-no-code":
        return `No output settler is deployed on ${dest}.`;
      case "wormhole-route-unavailable":
        return "The Wormhole deployment, Core or chain mapping is unavailable. Retry the route check; slow refund remains available after expiry.";
      case "wormhole-publication-unavailable":
        return "Wormhole publication history is unavailable. Retry with an archival RPC or the publication transaction; do not publish again.";
      case "solana-refund-too-large":
        return "This order is too large for a Solana fast refund.";
      case "solana-window-elapsed":
        return "Solana non-fill proofs must be created within 48h of the fill deadline.";
      case "solana-attestation-consumed":
      case "solana-attestation-legacy":
        return "A non-fill record for this output already exists in an unusable state.";
      case "expiry-buffer":
        return "Too close to expiry to start a fast refund.";
    }
  }

  function explain(v: RefundView): string {
    switch (v.kind) {
      case "unsupported":
        switch (v.reason) {
          case "compact":
            return "This is a Compact (resource-lock) order. Refunds go through The Compact, not this page.";
          case "multichain":
            return "Multichain orders aren't supported here.";
          case "unknown-settler":
            return "This order uses an input settler this page doesn't know.";
          case "unsupported-chain":
            return `${originChainId !== null ? chainLabel(originChainId) : "This chain"} isn't supported on lintent yet. The LI.FI auto-refund service refunds unfilled orders after expiry.`;
          case "orderid-mismatch":
            return "The order data doesn't hash to this order id. Refusing to act.";
        }
        break;
      case "not-opened":
        return `No deposit for this order was found on ${chainLabel(originChainId!)}. There is nothing to refund.`;
      case "refunded":
        return `Refunded to ${user}.`;
      case "claimed":
        return "A solver delivered this order and claimed the inputs.";
      case "settled":
        return "This order is already settled on Solana (claimed or refunded).";
      case "filled": {
        const which = v.outputIndexes.length
          ? v.outputIndexes
              .map((i) => `Output #${i} was delivered on ${chainLabel(outputs[i]!.chainId)}`)
              .join("; ")
          : "The order service reports this order as delivered";
        return `${which}. The solver settles this order, so it can't be refunded. If this looks wrong, contact support with the order id.`;
      }
      case "fill-unverifiable":
        return `Can't verify ${v.outputIndexes
          .map((i) => `output #${i} on ${chainLabel(outputs[i]!.chainId)}`)
          .join(
            ", "
          )} from this page. The LI.FI auto-refund service handles this order after expiry.`;
      case "waiting-fill-deadline":
        return `A solver can still fill until ${at(standard!.fillDeadline)}.${
          v.fastAt !== null ? " Fast refund opens then;" : ""
        } the slow refund unlocks at ${at(v.slowAt)}.`;
      case "waiting-expiry":
        return `Slow refund unlocks ${at(v.slowAt)}. ${reasonLine(v.fastReason)}`.trim();
      case "fast":
        return v.finishOnly
          ? "A non-fill proof is already on the origin chain. Finish the fast refund before expiry."
          : "The fill deadline passed with no fill. Prove that on the destination to refund before expiry.";
      case "slow":
        return "Expired and unfilled. Refund now.";
    }
    return "";
  }

  const fillLabel = (index: number) => flow.snapshot?.outputs[index];
  const escrowLabel = $derived(
    flow.snapshot
      ? flow.snapshot.escrow === "closed"
        ? "Closed"
        : flow.snapshot.escrow[0]!.toUpperCase() + flow.snapshot.escrow.slice(1)
      : null
  );

  let copied = $state<string | null>(null);
  async function copy(text: string) {
    if (await copyToClipboard(text)) {
      copied = text;
      setTimeout(() => (copied = copied === text ? null : copied), 1500);
    }
  }
  const short = (value: string) =>
    value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
</script>

{#snippet copyable(value: string)}
  <button
    type="button"
    class="cursor-pointer font-mono text-gray-700 hover:text-sky-700"
    title="Copy"
    onclick={() => copy(value)}
  >
    {short(value)}{copied === value ? " ✓" : ""}
  </button>
{/snippet}

<SectionCard title="Order">
  {#snippet headerRight()}
    {#if badge}
      <span class={["rounded border px-2 py-0.5 text-xs font-medium", TONE_CLASS[badge.tone]]}>
        {badge.text}
      </span>
    {/if}
  {/snippet}
  <dl class="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 text-xs">
    <dt class="text-gray-500">Order id</dt>
    <dd>
      {@render copyable(order.orderId)}
      {#if order.resolvedFrom}
        <span class="text-gray-500">
          (resolved from tx on {chainLabel(order.resolvedFrom.chainId)})
        </span>
      {/if}
    </dd>
    {#if originChainId !== null}
      <dt class="text-gray-500">Route</dt>
      <dd>{chainLabel(originChainId)} → {destChainIds.map(chainLabel).join(", ")}</dd>
    {/if}
    {#if row}
      <dt class="text-gray-500">Input</dt>
      <dd>{row.inputChips.map((chip) => chip.text).join(", ")}</dd>
      <dt class="text-gray-500">Output</dt>
      <dd class="flex flex-wrap gap-x-2">
        {#each row.outputChips as chip, i (chip.key)}
          <span>
            {chip.text}
            {#if fillLabel(i)}
              <span
                class={[
                  "ml-1 rounded px-1",
                  fillLabel(i) === "filled"
                    ? "bg-rose-50 text-rose-700"
                    : fillLabel(i) === "unfilled"
                      ? "bg-gray-100 text-gray-600"
                      : "bg-amber-50 text-amber-700"
                ]}>{fillLabel(i)}</span
              >
            {/if}
          </span>
        {/each}
      </dd>
    {/if}
    <dt class="text-gray-500">Refund to</dt>
    <dd class="font-mono break-all">{user}</dd>
    {#if standard}
      <dt class="text-gray-500">Fill deadline</dt>
      <dd>{at(standard.fillDeadline)}</dd>
      <dt class="text-gray-500">Expires</dt>
      <dd>{at(standard.expires)}</dd>
    {/if}
    <dt class="text-gray-500">Status</dt>
    <dd>
      Order service: {order.meta.orderStatus ?? "unknown"}
      {#if escrowLabel}· On-chain escrow: {escrowLabel}{/if}
    </dd>
    {#if order.meta.orderInitiatedTxHash}
      <dt class="text-gray-500">Open tx</dt>
      <dd>{@render copyable(order.meta.orderInitiatedTxHash)}</dd>
    {/if}
    {#if order.meta.refundTxHash}
      <dt class="text-gray-500">Refund tx</dt>
      <dd>{@render copyable(order.meta.refundTxHash)}</dd>
    {/if}
  </dl>
  {#if view}
    <p class="mt-2 text-sm text-gray-700">{explain(view)}</p>
  {:else if flow.refreshing}
    <p class="mt-2 text-sm text-gray-500">Reading on-chain state…</p>
  {/if}
  {#if flow.readError}
    <p class="mt-1 text-xs text-rose-600">
      {flow.readError}
      <button class="cursor-pointer underline" onclick={() => flow.refresh()}>Retry</button>
    </p>
  {/if}
</SectionCard>
