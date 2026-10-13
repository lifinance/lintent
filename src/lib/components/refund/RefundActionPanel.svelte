<script lang="ts">
  import SectionCard from "$lib/components/ui/SectionCard.svelte";
  import ChainWalletSlot from "./ChainWalletSlot.svelte";
  import store from "$lib/state.svelte";
  import type { RefundFlow } from "$lib/libraries/refundFlow.svelte";
  import { formatRelativeDeadline } from "$lib/libraries/intentList";
  import { chainLabel, type FastStep } from "$lib/libraries/refundState";
  import { formatAddressForChain, getChainType } from "$lib/utils/chainType";
  import { copyToClipboard } from "$lib/utils/clipboard";
  import { getChain } from "$lib/config";
  import { oracleProviderFor } from "$lib/libraries/oracleRoute";

  let { flow }: { flow: RefundFlow } = $props();

  const order = $derived(flow.order!.order!);
  const view = $derived(flow.view!);
  const origin = $derived(order.originChainId);
  const dest = $derived(view.kind === "fast" ? view.rail.output.chainId : null);
  const user = $derived(formatAddressForChain(order.user, origin));
  const wormhole = $derived(oracleProviderFor(origin, order.inputOracle) === "wormhole");

  const VM_NAME = { evm: "EVM", tron: "Tron", solana: "Solana" } as const;

  /** Why an action on `chainId` can't be sent yet, or null when it can. */
  function walletBlocker(chainId: bigint): string | null {
    const vm = getChainType(chainId);
    const ready =
      vm === "evm"
        ? !!store.walletClient && !!store.connectedAccount
        : !!store.accountForChain(chainId);
    return ready ? null : `Connect a ${VM_NAME[vm]} wallet for ${chainLabel(chainId)}`;
  }

  const STEPS: {
    step: FastStep;
    label: (chain: string) => string;
    button: string;
    busy: string;
  }[] = $derived([
    {
      step: "record",
      label: (c) => (wormhole ? `Publish non-fill on ${c}` : `Prove "not filled" on ${c}`),
      button: wormhole ? "Publish" : "Emit",
      busy: wormhole ? "Publishing…" : "Emitting…"
    },
    {
      step: "prove",
      label: (c) => (wormhole ? `Verify/post VAA and register on ${c}` : `Deliver proof to ${c}`),
      button: wormhole ? "Get VAA & register" : "Get proof & submit",
      busy: "Working…"
    },
    { step: "refund", label: (c) => `Refund on ${c}`, button: "Refund", busy: "Refunding…" }
  ]);
  const ORDER: Record<FastStep, number> = { record: 0, prove: 1, refund: 2 };

  const source = $derived.by(() => {
    const fast = flow.snapshot?.fast;
    if (!fast || !("rail" in fast) || !fast.source) return null;
    if (fast.source.kind === "wormhole") return fast.source.publication.txRef ?? null;
    return fast.source.kind === "evm" ? fast.source.txHash : fast.source.signature;
  });
  const publication = $derived.by(() => {
    const fast = flow.snapshot?.fast;
    return fast && "rail" in fast && fast.source?.kind === "wormhole"
      ? fast.source.publication
      : null;
  });
  const vaaHref = $derived(
    publication
      ? `${publication.id.network === "mainnet" ? "https://api.wormholescan.io" : "https://api.testnet.wormholescan.io"}/v1/signed_vaa/${publication.id.emitterChain}/${publication.id.emitter.slice(2).toLowerCase()}/${publication.id.sequence}`
      : null
  );

  function transactionHref(tx: string, chainId: bigint): string | undefined {
    const vm = getChainType(chainId);
    if (vm === "solana") return `https://solscan.io/tx/${encodeURIComponent(tx)}`;
    if (vm === "tron") return `https://tronscan.org/#/transaction/${tx.replace(/^0x/, "")}`;
    const explorer = getChain(chainId).blockExplorers?.default.url;
    return explorer ? `${explorer}/tx/${tx}` : undefined;
  }

  function doneTx(step: FastStep): string | null {
    if (step === "record") return flow.lastTx.record ?? source;
    if (step === "prove") return flow.lastTx.prove ?? null;
    return flow.lastTx.fast ?? null;
  }

  function stepChain(step: FastStep): bigint {
    return step === "record" ? dest! : origin;
  }

  function run(step: FastStep) {
    if (step === "record") return flow.runRecord();
    if (step === "prove") return flow.runProve();
    return flow.runFastRefund();
  }

  const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
  const at = (secs: number) =>
    `${new Date(secs * 1000).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    })} (${formatRelativeDeadline(secs - flow.now)})`;

  const primary =
    "h-8 rounded border border-emerald-200 bg-emerald-50 px-3 text-sm font-semibold text-emerald-900 hover:border-emerald-300 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400";
</script>

<SectionCard title="Refund">
  {#snippet headerRight()}
    <button
      type="button"
      class="cursor-pointer text-xs text-sky-700 hover:underline disabled:cursor-not-allowed disabled:text-gray-400"
      disabled={flow.refreshing || flow.busy !== null}
      onclick={() => flow.refresh()}
    >
      {flow.refreshing ? "Refreshing…" : "Refresh"}
    </button>
  {/snippet}

  <div class="space-y-1 border-b border-gray-100 pb-2">
    {#if wormhole && dest !== null}
      <ChainWalletSlot
        chainId={dest}
        role="Publication"
        sameAsOrigin={getChainType(dest) === "evm" && getChainType(origin) === "evm"}
      />
      <ChainWalletSlot chainId={origin} role="Proof / refund" />
    {:else}
      <ChainWalletSlot chainId={origin} role="Origin" />
      {#if dest !== null}
        <ChainWalletSlot
          chainId={dest}
          role="Destination"
          sameAsOrigin={getChainType(dest) === "evm" && getChainType(origin) === "evm"}
        />
      {/if}
    {/if}
  </div>

  <div class="mt-3 space-y-2">
    {#if view.kind === "slow"}
      {@const blocker = walletBlocker(origin)}
      <button
        type="button"
        class={[primary, "w-full"]}
        disabled={flow.busy !== null ||
          flow.refreshing ||
          flow.readError !== null ||
          blocker !== null}
        title={blocker ?? undefined}
        onclick={() => flow.runSlowRefund()}
      >
        {flow.busy === "slow" ? "Refunding…" : `Refund to ${short(user)}`}
      </button>
      {#if flow.lastTx.slow}
        <p class="text-xs text-gray-500">
          Sent: <button
            class="cursor-pointer font-mono hover:text-sky-700"
            onclick={() => copyToClipboard(flow.lastTx.slow!)}>{short(flow.lastTx.slow)}</button
          >
        </p>
      {/if}
    {:else if view.kind === "fast"}
      <ol class="space-y-2">
        {#each STEPS as s, i (s.step)}
          {@const current = view.step === s.step}
          {@const done = ORDER[s.step] < ORDER[view.step]}
          {@const chain = stepChain(s.step)}
          {@const blocker = current ? walletBlocker(chain) : null}
          {@const tx = done ? doneTx(s.step) : null}
          <li
            class={[
              "flex items-center justify-between gap-2 text-sm",
              !current && !done && "text-gray-400"
            ]}
          >
            <span>
              <span class="mr-1 font-semibold">{done ? "✓" : i + 1}</span>
              {s.label(chainLabel(chain))}
              {#if tx}
                {@const href = transactionHref(tx, chain)}
                {#if href}
                  <a
                    class="ml-1 font-mono text-xs text-sky-700 hover:underline"
                    {href}
                    target="_blank"
                    rel="noreferrer"
                    title={tx}>{short(tx)}</a
                  >
                {:else}
                  <button
                    class="ml-1 cursor-pointer font-mono text-xs text-gray-500 hover:text-sky-700"
                    title="Copy"
                    onclick={() => copyToClipboard(tx)}>{short(tx)}</button
                  >
                {/if}
              {/if}
            </span>
            {#if current}
              <button
                type="button"
                class={primary}
                disabled={flow.busy !== null ||
                  flow.refreshing ||
                  flow.readError !== null ||
                  blocker !== null}
                title={blocker ?? undefined}
                onclick={() => run(s.step)}
              >
                {flow.busy === s.step
                  ? s.busy
                  : s.step === "prove" && flow.proofStatus === "not-ready"
                    ? "Check again"
                    : s.button}
              </button>
            {/if}
          </li>
        {/each}
      </ol>
      {#if view.step === "prove"}
        {#if flow.busy === "prove" && flow.proofStage}
          <p class="text-xs text-gray-600">
            {flow.proofStage}{#if flow.proofStatus && flow.proofStatus !== "not-ready"}
              ({flow.proofStatus.attempt}/{flow.proofStatus.total}){/if}
          </p>
        {:else if flow.proofStatus === "not-ready"}
          <p class="text-xs text-amber-700">
            {wormhole
              ? "Waiting for Wormhole guardians. Check again resumes the same publication; it does not publish or consume another record."
              : "Polymer hasn't produced the proof yet. Check again resumes the same proof request."}
          </p>
        {/if}
      {/if}
      {#if publication && vaaHref}
        <p class="text-xs text-gray-500">
          Message {publication.id.emitterChain} / {publication.id.sequence} ·
          <a class="text-sky-700 hover:underline" href={vaaHref} target="_blank" rel="noreferrer"
            >Signed VAA</a
          >
        </p>
      {/if}
      <p class="text-xs text-gray-500">Slow refund unlocks {at(view.slowAt)}.</p>
    {/if}
    <p class="text-xs text-gray-400">
      Anyone can send these; funds always go to the order's user. You pay gas on each chain.
    </p>
    {#if flow.actionError}
      <p class="text-xs text-rose-600">{flow.actionError}</p>
    {/if}
  </div>
</SectionCard>
