<script lang="ts">
  import { toBigIntWithDecimals } from "@lifi/intent";

  let {
    value,
    decimals
  }: {
    value: Promise<bigint>;
    decimals: number;
  } = $props();
</script>

{#await value}
  <input
    type="text"
    class="w-20 cursor-not-allowed rounded border border-gray-700 bg-gray-50 px-2 py-1 text-gray-600"
    disabled
    value="..."
  />
{:then value}
  <input
    type="text"
    class="w-20 cursor-not-allowed rounded border border-gray-700 bg-gray-50 px-2 py-1 text-gray-600"
    disabled
    value={Number(value) / 10 ** decimals}
  />
{:catch error}
  <input
    type="text"
    class="w-20 cursor-not-allowed rounded border border-gray-700 bg-gray-50 px-2 py-1 text-gray-600"
    disabled
    value="err"
  />
{/await}
