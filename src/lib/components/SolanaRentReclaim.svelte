<script lang="ts">
  import { onMount } from "svelte";
  import { getOutputHash, type OrderContainer } from "@lifi/intent";
  import { Solver } from "$lib/libraries/solver";
  import { getSolanaReads } from "$lib/solana/client";
  import { readFillRecord, readChainTimestamp } from "$lib/solana/reads";
  import { containerToIntent } from "$lib/utils/intent";
  import { isSolanaChain } from "$lib/utils/chainType";
  import { getChainName } from "$lib/config";
  import { getOutputStorageKey } from "$lib/libraries/flowProgress";
  import { solanaFillEvidence } from "$lib/libraries/solanaHistory";
  import store from "$lib/state.svelte";
  import SectionCard from "./ui/SectionCard.svelte";

  let { orderContainer }: { orderContainer: OrderContainer } = $props();
  const outputs = $derived(
    orderContainer.order.outputs.filter((output) => isSolanaChain(output.chainId))
  );
  type RentState = {
    record: Awaited<ReturnType<typeof readFillRecord>>;
    now: number;
    hasHistory: boolean;
    error?: string;
  };
  let states = $state<Record<string, RentState>>({});
  let refresh = $state(0);
  let busy = $state<string | undefined>();
  let actionError = $state("");

  onMount(() => {
    const timer = setInterval(() => refresh++, 30_000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    void refresh;
    const orderId = containerToIntent(orderContainer).orderId();
    const entries = outputs.map((output) => ({
      output,
      signature: store.fillTransactions[getOutputStorageKey(output)]
    }));
    let cancelled = false;
    void Promise.all(
      entries.map(async ({ output, signature }) => {
        const key = getOutputHash(output);
        try {
          const reads = await getSolanaReads(output.chainId);
          const [record, now] = await Promise.all([
            readFillRecord(reads, { orderId, output }),
            readChainTimestamp(reads)
          ]);
          const hasHistory = !!(await solanaFillEvidence(orderId, output, signature));
          return [key, { record, now, hasHistory }] as const;
        } catch (error) {
          return [
            key,
            {
              record: null,
              now: 0,
              hasHistory: false,
              error: error instanceof Error ? error.message : String(error)
            }
          ] as const;
        }
      })
    ).then((entries) => {
      if (!cancelled) states = Object.fromEntries(entries);
    });
    return () => {
      cancelled = true;
    };
  });

  async function reclaim(output: OrderContainer["order"]["outputs"][number]) {
    busy = getOutputHash(output);
    actionError = "";
    try {
      await Solver.reclaimFillRent(
        orderContainer,
        output,
        store.fillTransactions[getOutputStorageKey(output)]
      );
      refresh++;
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      busy = undefined;
    }
  }
</script>

{#if outputs.length}
  <SectionCard compact title="Solana fill rent">
    <div class="space-y-2 text-xs text-gray-600">
      <button type="button" class="text-sky-700 underline" onclick={() => refresh++}
        >Refresh rent status</button
      >
      {#each outputs as output (getOutputHash(output))}
        {@const status = states[getOutputHash(output)]}
        {#if status?.record}
          <div>
            <div>
              {getChainName(output.chainId)} · {(status.record.lamports / 1e9).toFixed(6)} SOL
            </div>
            <div class="break-all">Refund to {status.record.rentRefund}</div>
            <div>
              Reclaim after {new Date(Number(status.record.closeAfter) * 1000).toLocaleString()}
            </div>
            <button
              type="button"
              class="mt-1 rounded border border-gray-200 px-2 py-1 font-semibold disabled:opacity-50"
              disabled={!!busy ||
                BigInt(status.now) <= status.record.closeAfter ||
                !status.hasHistory}
              onclick={() => reclaim(output)}
              >{busy === getOutputHash(output) ? "Reclaiming…" : "Reclaim rent"}</button
            >
            {#if !status.hasHistory}<p>
                Add the confirmed fill transaction to preserve its history before reclaiming.
              </p>{/if}
          </div>
        {:else if status?.hasHistory}
          <p>Fill record rent already reclaimed.</p>
        {:else if status?.error}
          <p>{status.error}</p>
        {:else}
          <p>Rent details appear after the output is filled.</p>
        {/if}
      {/each}
      {#if actionError}<p role="alert" class="break-words text-rose-700">{actionError}</p>{/if}
    </div>
  </SectionCard>
{/if}
