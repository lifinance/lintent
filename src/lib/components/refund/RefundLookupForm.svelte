<script lang="ts">
  import SectionCard from "$lib/components/ui/SectionCard.svelte";
  import FormControl from "$lib/components/ui/FormControl.svelte";
  import type { RefundFlow } from "$lib/libraries/refundFlow.svelte";

  let { flow }: { flow: RefundFlow } = $props();
</script>

<SectionCard title="Find your order">
  <form
    class="flex gap-2"
    onsubmit={(event) => {
      event.preventDefault();
      flow.lookup(flow.input);
    }}
  >
    <FormControl
      bind:value={flow.input}
      className="flex-1 font-mono"
      placeholder="Order ID or open-transaction hash/signature"
      aria-label="Order ID or open transaction"
      spellcheck="false"
      autocomplete="off"
    />
    <button
      type="submit"
      class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 hover:border-sky-300 hover:text-sky-700 disabled:cursor-not-allowed disabled:text-gray-400 disabled:hover:border-gray-200"
      disabled={flow.busy !== null}
    >
      {flow.busy === "lookup" ? "Looking up…" : "Look up"}
    </button>
  </form>
  <p class="mt-1 text-xs text-gray-500">
    0x… order id, EVM/Tron transaction hash, or Solana signature.
  </p>
  {#if flow.lookupError}
    <p class="mt-1 text-xs text-rose-600">{flow.lookupError}</p>
  {/if}
</SectionCard>
