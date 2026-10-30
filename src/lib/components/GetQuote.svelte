<script lang="ts">
  import { onDestroy } from "svelte";
  import { IntentApi } from "@lifi/intent";
  import {
    apiQuoteRequest,
    validateApiQuote,
    type ApiQuoteContext,
    type SelectedApiQuote
  } from "$lib/libraries/apiQuote";
  import { isStellarChain } from "$lib/config";

  let {
    exclusiveFor = $bindable(),
    outputTokens = $bindable(),
    selectedQuote = $bindable(),
    context,
    mainnet,
    useProductionApi,
    scope,
    blocked = false
  }: {
    exclusiveFor: string;
    outputTokens: ApiQuoteContext["outputs"];
    selectedQuote: SelectedApiQuote | undefined;
    context: ApiQuoteContext;
    mainnet: boolean;
    useProductionApi: boolean | null;
    scope: string;
    blocked?: boolean;
  } = $props();
  const corridor = $derived(
    [...context.inputs, ...context.outputs].some(({ token }) => isStellarChain(token.chainId))
  );
  const requestKey = $derived(
    JSON.stringify(
      {
        inputs: context.inputs,
        outputs: context.outputs.map(({ token }) => token),
        user: context.user,
        recipient: context.recipient,
        exclusiveFor: context.exclusiveFor,
        mainnet,
        useProductionApi,
        scope,
        blocked
      },
      (_, value) => (typeof value === "bigint" ? value.toString() : value)
    )
  );
  let generation = 0;
  let loading = $state(false);
  let message = $state("No quote selected");
  let expires = $state(0);
  let now = $state(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  $effect(() => {
    requestKey;
    generation += 1;
    selectedQuote = undefined;
    expires = 0;
    loading = false;
    message = blocked ? "Route unavailable" : "No quote selected";
    if (blocked || !context.user || !context.recipient) return;
    const timeout = setTimeout(updateQuote, 500);
    return () => clearTimeout(timeout);
  });
  $effect(() => {
    timer = setInterval(() => {
      now = Date.now();
      if (expires && now >= expires) {
        selectedQuote = undefined;
        expires = 0;
        message = "Quote expired";
        generation += 1;
      }
    }, 1000);
    return () => clearInterval(timer);
  });
  onDestroy(() => {
    generation += 1;
    clearInterval(timer);
  });
  $effect(() => {
    if (
      selectedQuote &&
      outputTokens.some(
        (item, i) => item.amount !== BigInt(selectedQuote!.preview.outputs[i]?.amount ?? "-1")
      )
    ) {
      selectedQuote = undefined;
      expires = 0;
      message = "Quote invalidated by amount change";
      generation += 1;
    }
  });
  export async function updateQuote() {
    const id = ++generation;
    selectedQuote = undefined;
    expires = 0;
    if (blocked) return;
    loading = true;
    message = "Requesting quote";
    try {
      const request = apiQuoteRequest(context);
      const response = await new IntentApi(
        corridor ? false : (useProductionApi ?? mainnet)
      ).getQuotes(request);
      if (id !== generation) return;
      const quote = response.quotes[0];
      if (!quote) {
        message = "No quote available";
        return;
      }
      const validated = corridor ? validateApiQuote(quote, context) : undefined;
      selectedQuote = quote;
      expires = Math.min(
        quote.validUntil ? quote.validUntil * 1000 : Infinity,
        validated ? validated.order.expires * 1000 : Date.now() + 30_000
      );
      outputTokens[0].amount = BigInt(quote.preview.outputs[0].amount);
      // Locked exclusivity is a request input; do not overwrite it with the response.
      if (!context.exclusiveFor) exclusiveFor = quote.metadata.exclusiveFor ?? "";
      message = `Quote ${quote.quoteId}`;
    } catch (error) {
      if (id === generation) message = error instanceof Error ? error.message : String(error);
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
  <p data-testid="quote-state">
    {message}{selectedQuote ? ` · ${Math.max(0, Math.ceil((expires - now) / 1000))}s` : ""}
  </p>
  {#if selectedQuote}<p class="max-w-48 truncate" title={selectedQuote.metadata.quoteReference}>
      Reference: {selectedQuote.metadata.quoteReference}
    </p>{/if}
</div>
