<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { IntentApi } from "@lifi/intent";
  import {
    apiQuoteDeadlineMs,
    apiQuoteRequest,
    validateApiQuote,
    type ApiQuoteStatus,
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
    status = $bindable("idle"),
    context,
    mainnet,
    useProductionApi,
    scope,
    blocked = false,
    required = false,
    paused = false
  }: {
    exclusiveFor: string;
    outputTokens: ApiQuoteContext["outputs"];
    selectedQuote: SelectedApiQuote | undefined;
    generation: number;
    status?: ApiQuoteStatus;
    context: ApiQuoteContext;
    mainnet: boolean;
    useProductionApi: boolean | null;
    scope: string;
    blocked?: boolean;
    /** The route can only execute this quote: keep one live and own the output amounts. */
    required?: boolean;
    /** A quote is being executed: never revoke or replace it underneath that. */
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
  let loading = $state(false);
  // Only failures are surfaced here; the rest is reported through `status` and
  // rendered by the issue button, which is where the user acts on it.
  let error = $state<string | undefined>();
  let empty = $state(false);
  let expires = $state(0);
  let now = $state(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const hasParties = $derived(!!context.user && !!context.recipient);

  $effect(() => {
    status = blocked
      ? "blocked"
      : !hasParties
        ? "needs-party"
        : loading
          ? "loading"
          : selectedQuote
            ? "ready"
            : error
              ? "error"
              : empty
                ? "empty"
                : "idle";
  });

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
    requestKey;
    untrack(() => {
      revokeQuote();
      loading = false;
      error = undefined;
      empty = false;
      cancelPending();
      if (!blocked && hasParties) scheduleQuote();
    });
    return cancelPending;
  });
  $effect(() => {
    timer = setInterval(() => {
      now = Date.now();
      // Execution re-checks every deadline itself; replacing the quote under it
      // would unmount its pending button and allow a second execution.
      if (paused) return;
      // On quote-only routes an expired quote is replaced, not just dropped: the
      // user should never have to notice expiry to keep a usable quote.
      if (expires && now >= expires) {
        revokeQuote();
        if (required && !blocked && hasParties) void updateQuote();
      }
    }, 1000);
    return () => clearInterval(timer);
  });
  onDestroy(() => {
    revokeQuote();
    cancelPending();
    clearInterval(timer);
  });
  // An edited output amount no longer matches the quote. On quote-only routes
  // the amounts are the quote's, so re-quote (which writes them back); elsewhere
  // the quote is advisory and the user's edit stands.
  $effect(() => {
    if (
      !paused &&
      selectedQuote &&
      selectedQuote.preview.outputs.some(
        (output, i) => outputTokens[i] && outputTokens[i].amount !== BigInt(output.amount)
      )
    ) {
      untrack(() => {
        revokeQuote();
        if (required) scheduleQuote();
      });
    }
  });
  /** Quote-only routes must not keep showing amounts from a quote that is gone. */
  function clearQuotedAmounts() {
    if (required) for (const output of outputTokens) output.amount = 0n;
  }
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
    try {
      const request = apiQuoteRequest(context);
      const response = await new IntentApi(resolveProductionApi(useProductionApi)).getQuotes(
        request
      );
      if (id !== generation) return;
      // On advisory routes the user's amounts win over a quote they've since edited.
      if (!required && outputTokens.some((output, i) => output.amount !== amountsAtRequest[i]))
        return;
      const quote = response.quotes[0];
      if (!quote) {
        empty = true;
        clearQuotedAmounts();
        return;
      }
      const validated = corridor ? validateApiQuote(quote, context) : undefined;
      const deadline = apiQuoteDeadlineMs(quote, validated?.order);
      // Re-quoting on expiry would spin once a second on a quote that is
      // already dead on arrival (e.g. a skewed local clock); surface it instead.
      if (deadline <= Date.now()) throw new Error("Quote expired on arrival — check system clock");
      selectedQuote = quote;
      expires = deadline;
      // Write back every quoted output, so the edit check below compares like with like.
      quote.preview.outputs.forEach((output, i) => {
        if (outputTokens[i]) outputTokens[i].amount = BigInt(output.amount);
      });
      // Locked exclusivity is a request input; do not overwrite it with the response.
      if (!context.exclusiveFor) exclusiveFor = quote.metadata.exclusiveFor ?? "";
    } catch (err) {
      if (id === generation) {
        error = err instanceof Error ? err.message : String(err);
        clearQuotedAmounts();
      }
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
