<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { RefundFlow } from "$lib/libraries/refundFlow.svelte";
  import RefundLookupForm from "$lib/components/refund/RefundLookupForm.svelte";
  import RefundStatusCard from "$lib/components/refund/RefundStatusCard.svelte";
  import RefundActionPanel from "$lib/components/refund/RefundActionPanel.svelte";

  // `?order=` is the resume key: a reload re-derives every step from chain.
  const flow = new RefundFlow({
    onInput: (raw) => replaceState(`?order=${encodeURIComponent(raw)}`, {})
  });

  onMount(() => {
    const query = page.url.searchParams.get("order");
    if (query) {
      flow.input = query;
      flow.lookup(query);
    }
    return flow.start();
  });
</script>

<svelte:head>
  <title>Refund an intent · lintent</title>
</svelte:head>

<main class="mx-auto max-w-xl space-y-3 px-4 pt-6 pb-10">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-medium text-gray-900">Refund an intent</h1>
    <a href="/" class="text-xs text-sky-700 hover:underline">← lintent.org</a>
  </div>
  <RefundLookupForm {flow} />
  {#if flow.order}
    <RefundStatusCard {flow} />
  {/if}
  {#if flow.view?.kind === "slow" || flow.view?.kind === "fast"}
    <RefundActionPanel {flow} />
  {/if}
</main>
