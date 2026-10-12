<script lang="ts">
  import SectionCard from "$lib/components/ui/SectionCard.svelte";
  import FormControl from "$lib/components/ui/FormControl.svelte";
  import AwaitButton from "$lib/components/AwaitButton.svelte";
  import type { RefundFlow } from "$lib/libraries/refundFlow.svelte";

  let { flow }: { flow: RefundFlow } = $props();
</script>

<SectionCard title="Find your order">
  <form
    class="flex gap-2"
    onsubmit={(event) => {
      event.preventDefault();
      if (flow.busy !== "lookup") flow.lookup(flow.input);
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
    <AwaitButton buttonFunction={() => flow.lookup(flow.input)}>
      {#snippet name()}Look up{/snippet}
      {#snippet awaiting()}Looking up…{/snippet}
    </AwaitButton>
  </form>
  <p class="mt-1 text-xs text-gray-500">
    0x… order id, EVM/Tron transaction hash, or Solana signature.
  </p>
  {#if flow.lookupError}
    <p class="mt-1 text-xs text-rose-600">{flow.lookupError}</p>
  {/if}
</SectionCard>
