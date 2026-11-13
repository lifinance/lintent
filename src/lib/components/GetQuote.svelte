<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { IntentApi } from "@lifi/intent";
  import {
    apiQuoteRequest,
    isCurrentQuoteRequest,
    validateApiQuote,
    type ApiQuoteContext,
    type SelectedApiQuote
  } from "$lib/libraries/apiQuote";
  import { isStellarChain } from "$lib/config";
  import { resolveProductionApi } from "$lib/utils/intentApiEnv";

  let {
    exclusiveFor = $bindable(),
    outputTokens = $bindable(),
    selectedQuote = $bindable(),
    generation = $bindable(0),
    context,
    mainnet,
    useProductionApi,
    scope,
    blocked = false
  }: {
    exclusiveFor: string;
    outputTokens: ApiQuoteContext["outputs"];
    selectedQuote: SelectedApiQuote | undefined;
    generation: number;
    context: ApiQuoteContext;
    mainnet: boolean;
    useProductionApi: boolean | null;
    scope: string;
    blocked?: boolean;
  } = $props();

  const corridor = $derived(
    [...context.inputs, ...context.outputs].some(({ token }) => isStellarChain(token.chainId))
  );
  /**
   * Everything the request is built from, as a comparable value. Every party is
   * named in its own chain's namespace, so a quote depends on the user, the
   * recipient (override or destination wallet) and the exclusivity / 1:1 demo
   * settings as much as on the tokens; any change revokes the selected quote.
   * Output amounts are absent: this component writes them back from the response.
   */
  const requestKey = $derived(
    JSON.stringify(
      {
        inputs: context.inputs,
        outputs: context.outputs.map(({ token }) => token),
        user: context.user,
        recipient: context.recipient,
        exclusiveFor: context.exclusiveFor,
        integratorKey: context.integratorKey,
        mainnet,
        useProductionApi,
        scope,
        blocked
      },
      (_, value) => (typeof value === "bigint" ? value.toString() : value)
    )
  );
  let loading = $state(false);
  // Only failures are surfaced; idle / loading / success states speak through the button.
  let error = $state<string | undefined>();
  let expires = $state(0);
  let now = $state(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  function revokeQuote() {
    generation = untrack(() => generation) + 1;
    selectedQuote = undefined;
    expires = 0;
  }
  $effect(() => {
    requestKey;
    revokeQuote();
    loading = false;
    error = undefined;
    // A missing counterparty identity is an ordinary UI state (connect a wallet
    // or name a recipient), not a failed request.
    if (blocked || !context.user || !context.recipient) return;
    // Debounced, and cancelled on change, so typing an amount or a recipient
    // sends one request rather than one per keystroke.
    const timeout = setTimeout(updateQuote, 500);
    return () => clearTimeout(timeout);
  });
  $effect(() => {
    timer = setInterval(() => {
      now = Date.now();
      if (expires && now >= expires) {
        revokeQuote();
      }
    }, 1000);
    return () => clearInterval(timer);
  });
  onDestroy(() => {
    revokeQuote();
    clearInterval(timer);
  });
  $effect(() => {
    if (
      selectedQuote &&
      outputTokens.some(
        (item, i) => item.amount !== BigInt(selectedQuote!.preview.outputs[i]?.amount ?? "-1")
      )
    ) {
      revokeQuote();
    }
  });
  export async function updateQuote() {
    revokeQuote();
    const id = generation;
    if (blocked) return;
    loading = true;
    error = undefined;
    try {
      const request = apiQuoteRequest(context);
      const response = await new IntentApi(resolveProductionApi(useProductionApi)).getQuotes(
        request
      );
      if (!isCurrentQuoteRequest(id, generation)) return;
      const quote = response.quotes[0];
      if (!quote) return;
      const validated = corridor ? validateApiQuote(quote, context) : undefined;
      selectedQuote = quote;
      expires = Math.min(
        quote.validUntil ? quote.validUntil * 1000 : Infinity,
        validated ? validated.order.expires * 1000 : Date.now() + 30_000
      );
      outputTokens[0].amount = BigInt(quote.preview.outputs[0].amount);
      // Locked exclusivity is a request input; do not overwrite it with the response.
      if (!context.exclusiveFor) exclusiveFor = quote.metadata.exclusiveFor ?? "";
    } catch (err) {
      if (id === generation) error = err instanceof Error ? err.message : String(err);
    } finally {
      if (id === generation) loading = false;
    }
  }
</script>

<div class="text-right text-xs" aria-live="polite">
  <button
    data-testid="quote-button"
    class="rounded border border-gray-300 px-2 py-1 disabled:text-gray-400"
    disabled={blocked || loading || !context.user || !context.recipient}
    onclick={updateQuote}
  >
    {loading ? "Quoting…" : selectedQuote ? "Refresh quote" : "Get quote"}
  </button>
  {#if error}
    <p data-testid="quote-state" class="max-w-48 truncate text-red-600" title={error}>{error}</p>
  {:else if selectedQuote}
    <p
      data-testid="quote-state"
      class="text-gray-500"
      title={selectedQuote.metadata.quoteReference}
    >
      {Math.max(0, Math.ceil((expires - now) / 1000))}s
    </p>
  {/if}
</div>
