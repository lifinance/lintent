<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { IntentApi } from "@lifi/intent";
  import {
    apiQuoteDeadlineMs,
    apiQuoteRequest,
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
    blocked = false,
    paused = false
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
    /** An order is being opened: don't fetch or expire quotes underneath it. */
    paused?: boolean;
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
  // A quote is only a suggestion: it fills in the form, and nothing it does
  // (arriving, failing, expiring) ever blocks or overwrites the user's terms.
  let loading = $state(false);
  let error = $state<string | undefined>();
  let empty = $state(false);
  let expires = $state(0);
  let now = $state(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  // The exclusive solver as the selected quote left it; an edit revokes it.
  let appliedExclusiveFor: string | undefined;
  const hasParties = $derived(!!context.user && !!context.recipient);

  function revokeQuote() {
    generation = untrack(() => generation) + 1;
    selectedQuote = undefined;
    expires = 0;
  }
  function cancelPending() {
    if (pending !== undefined) clearTimeout(pending);
    pending = undefined;
  }
  /** Debounced (re)quote; a newer schedule or a manual request replaces it. */
  function scheduleQuote(delay = 500) {
    cancelPending();
    pending = setTimeout(() => {
      pending = undefined;
      void updateQuote();
    }, delay);
  }
  // Only a change to the serialized request revokes the quote. Everything else
  // is read untracked: `context` is rebuilt whenever any input of it changes
  // (including the exclusive solver this component writes back from a quote),
  // and tracking it would revoke a quote the moment it arrives.
  $effect(() => {
    void requestKey;
    untrack(() => {
      revokeQuote();
      loading = false;
      error = undefined;
      empty = false;
      cancelPending();
      if (!blocked && hasParties && !paused) scheduleQuote();
    });
    return cancelPending;
  });
  $effect(() => {
    timer = setInterval(() => {
      now = Date.now();
      // Execution re-checks every deadline itself.
      if (paused) return;
      // An expired quote is dropped; the amounts it filled in stay as they are.
      if (expires && now >= expires) revokeQuote();
    }, 1000);
    return () => clearInterval(timer);
  });
  onDestroy(() => {
    revokeQuote();
    cancelPending();
    clearInterval(timer);
  });
  // Editing what the quote filled in (an output amount, or the exclusive solver
  // while it isn't locked into the request) means the form is no longer the
  // quote's order: drop the quote and keep the edit. This applies mid-execution
  // too, so an in-flight quote open fails its re-validation instead.
  $effect(() => {
    if (
      selectedQuote &&
      (exclusiveFor !== appliedExclusiveFor ||
        selectedQuote.preview.outputs.some(
          (output, i) => outputTokens[i] && outputTokens[i].amount !== BigInt(output.amount)
        ))
    ) {
      untrack(revokeQuote);
    }
  });
  export async function updateQuote() {
    if (paused) return;
    cancelPending();
    revokeQuote();
    const id = generation;
    if (blocked) return;
    loading = true;
    error = undefined;
    empty = false;
    // Output amounts aren't part of the request, so an edit made while it is in
    // flight must be checked for explicitly.
    const amountsAtRequest = outputTokens.map((output) => output.amount);
    const exclusiveForAtRequest = exclusiveFor;
    try {
      const request = apiQuoteRequest(context);
      const response = await new IntentApi(resolveProductionApi(useProductionApi)).getQuotes(
        request
      );
      if (id !== generation) return;
      // What the user typed while the request was in flight wins over the quote.
      if (
        exclusiveFor !== exclusiveForAtRequest ||
        outputTokens.some((output, i) => output.amount !== amountsAtRequest[i])
      )
        return;
      const quote = response.quotes[0];
      if (!quote) {
        empty = true;
        return;
      }
      const validated = corridor ? validateApiQuote(quote, context) : undefined;
      const deadline = apiQuoteDeadlineMs(quote, validated?.order);
      // A quote dead on arrival (e.g. a skewed local clock) is surfaced, not applied.
      if (deadline <= Date.now()) throw new Error("Quote expired on arrival — check system clock");
      selectedQuote = quote;
      expires = deadline;
      // Write back every quoted output, so the edit check below compares like with like.
      quote.preview.outputs.forEach((output, i) => {
        if (outputTokens[i]) outputTokens[i].amount = BigInt(output.amount);
      });
      // Locked exclusivity is a request input; do not overwrite it with the response.
      if (!context.exclusiveFor) exclusiveFor = quote.metadata.exclusiveFor ?? "";
      appliedExclusiveFor = exclusiveFor;
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
    disabled={blocked || loading || paused || !hasParties}
    onclick={updateQuote}
  >
    {loading ? "Quoting…" : selectedQuote ? "Refresh quote" : "Get quote"}
  </button>
  {#if error}
    <p data-testid="quote-state" class="max-w-48 truncate text-red-600" title={error}>{error}</p>
  {:else if empty}
    <p data-testid="quote-state" class="text-gray-500">No quote</p>
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
