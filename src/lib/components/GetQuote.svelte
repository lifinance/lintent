<script lang="ts">
  import { IntentApi } from "@lifi/intent";
  import type { AppTokenContext } from "$lib/appTypes";
  import { resolveDemoQuoteParams } from "$lib/libraries/demoQuote";
  import { getChainType, namespaceForChain } from "$lib/utils/chainType";
  import { interval } from "rxjs";

  let {
    exclusiveFor = $bindable(),
    useExclusiveForQuoteRequest = false,
    use11Demo = false,
    integratorKey = "",
    inputTokens,
    outputTokens = $bindable(),
    accountForChain,
    outputRecipient,
    mainnet,
    useProductionApi
  }: {
    exclusiveFor: string;
    useExclusiveForQuoteRequest?: boolean;
    use11Demo?: boolean;
    integratorKey?: string;
    inputTokens: AppTokenContext[];
    outputTokens: AppTokenContext[];
    /**
     * The acting account on a chain, or undefined when no wallet for that
     * chain's namespace is connected. Deliberately not the screen's single
     * `account()`: every party in a quote is named in its own chain's
     * namespace, so an EVM -> Solana quote needs both wallets (or an explicit
     * recipient) before it can be requested at all.
     */
    accountForChain: (chainId: number | bigint) => `0x${string}` | undefined;
    /** The issuance form's recipient override, when set. */
    outputRecipient?: `0x${string}`;
    mainnet: boolean;
    useProductionApi: boolean | null;
  } = $props();

  const intentApi = $derived(new IntentApi(useProductionApi ?? mainnet));

  /**
   * Raised when a party in the quote has no address in its own namespace. It is
   * caught below and shown as "No Quote" rather than a broken request: asking
   * for a cross-namespace quote without a destination identity is a state the
   * user resolves by connecting a wallet or naming a recipient.
   */
  class MissingQuoteAddress extends Error {}

  function requireAccount(chainId: number | bigint): `0x${string}` {
    const resolved = accountForChain(chainId);
    if (!resolved) {
      throw new MissingQuoteAddress(`No connected account for chain ${chainId}`);
    }
    return resolved;
  }

  // Only the newest request may write back. Editing the recipient or switching
  // a destination wallet starts a new quote while an older one is in flight;
  // without this the slower response wins and the displayed output amount stops
  // matching what issuance would encode.
  let requestSeq = 0;

  async function getQuoteAndSet() {
    const seq = ++requestSeq;
    try {
      const { exclusiveFor: requestedExclusiveFor, integratorKey: requestedIntegratorKey } =
        resolveDemoQuoteParams({
          use11Demo,
          integratorKey,
          useExclusiveForQuoteRequest,
          exclusiveFor,
          inputChainType: getChainType(inputTokens[0].token.chainId)
        });

      const userChainId = inputTokens[0].token.chainId;

      // Every chain, address and asset is declared in its own CAIP-2 namespace.
      // `@lifi/intent` re-encodes the address fields to match the namespace it
      // is given, so the internal hex form is passed through unchanged here and
      // a Solana mint reaches the API as base58.
      const response = await intentApi.getQuotes({
        user: requireAccount(userChainId),
        userChainId,
        userNamespace: namespaceForChain(userChainId),
        exclusiveFor: requestedExclusiveFor,
        integratorKey: requestedIntegratorKey,
        inputs: inputTokens.map(({ token, amount }) => {
          return {
            sender: requireAccount(token.chainId),
            asset: token.address,
            chainId: token.chainId,
            namespace: namespaceForChain(token.chainId),
            amount: amount
          };
        }),
        outputs: outputTokens.map(({ token }) => {
          return {
            // The recipient override wins when set, matching what issuance will
            // actually encode; otherwise the destination chain's own wallet.
            receiver: outputRecipient ?? requireAccount(token.chainId),
            asset: token.address,
            chainId: token.chainId,
            namespace: namespaceForChain(token.chainId),
            amount: 0n
          };
        })
      });
      if (seq !== requestSeq) return;
      if (response?.quotes?.length ?? 0) {
        const quote = response.quotes[0];
        quoteExpires = new Date().getTime() + 30 * 1000;
        quoteDuration = quoteExpires - new Date().getTime();
        outputTokens[0].amount = BigInt(quote.preview.outputs[0].amount);
        exclusiveFor = Array.isArray(quote.metadata.exclusiveFor)
          ? (quote.metadata.exclusiveFor[0] ?? "")
          : (quote.metadata.exclusiveFor ?? "");
        updater();
      } else {
        quoteExpires = 0;
      }
    } catch (e) {
      if (seq !== requestSeq) return;
      // A missing counterparty wallet is an ordinary UI state, not a failure:
      // show "No Quote" and stop, rather than leaving the previous quote's
      // countdown running against a request that was never sent.
      quoteExpires = 0;
      if (e instanceof MissingQuoteAddress) return;
      console.log("Could not fetch a quote", e);
      return;
    }
  }

  const updater = () => {
    const timeLeft = quoteExpires - new Date().getTime();
    const percentageOfOriginalQuote = timeLeft / quoteDuration;
    const intermediatewidth = percentageOfOriginalQuote * 100;
    if (intermediatewidth <= 100 && intermediatewidth > 0) {
      width = intermediatewidth;
      return;
    }
    width = 0;
    updateQuote();
  };

  export function updateQuote() {
    quoteRequest = getQuoteAndSet();
  }

  /**
   * Everything the request is built from, as a comparable value.
   *
   * Each party is now named in its own namespace, so a quote depends on the
   * destination wallet and the recipient override as much as on the tokens.
   * Tracking only `mainnet` left a stale quote — and a stale output amount —
   * on screen after either changed, while issuance already used the new one.
   *
   * The output amount is deliberately absent: this component writes it back
   * from the response, so including it would re-trigger on its own result.
   *
   * The exclusivity toggles belong here: issuance encodes whichever solver the
   * last response wrote back into `exclusiveFor`, so a quote fetched under
   * different exclusivity settings is a stale quote — flipping "1:1 demo" or
   * "Lock Exclusive" has to fetch a new one. The solver text itself stays out
   * for the same reason the output amount does: this component writes it back
   * from the response, and a response that clears it would otherwise start a
   * request whose own response sets it again.
   */
  const quoteInputs = $derived(
    JSON.stringify({
      mainnet,
      useProductionApi,
      use11Demo,
      integratorKey,
      useExclusiveForQuoteRequest,
      outputRecipient: outputRecipient ?? null,
      inputs: inputTokens.map(({ token, amount }) => [
        String(token.chainId),
        token.address,
        amount.toString(),
        accountForChain(token.chainId) ?? null
      ]),
      outputs: outputTokens.map(({ token }) => [
        String(token.chainId),
        token.address,
        accountForChain(token.chainId) ?? null
      ])
    })
  );

  $effect(() => {
    quoteInputs;
    // Debounced, and cancelled on change, so typing an amount or a recipient
    // sends one request rather than one per keystroke.
    const handle = setTimeout(() => updateQuote(), 1000);
    return () => clearTimeout(handle);
  });

  $effect(() => {
    if (typeof window === "undefined") return;
    const onOnline = () => updateQuote();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  });

  $effect(() => {
    quoteExpires;
    if (quoteExpires === 0) {
      width = 0;
      counter.unsubscribe();
      return;
    }
    counter.unsubscribe();
    counter = interval(1000).subscribe(updater);
  });
  let quoteDuration = 30 * 1000;
  let counter = interval(1000).subscribe(updater);

  let quoteExpires = $state(new Date().getTime() + 5 * 1000);
  let width = $state(0);
  let quoteRequest: Promise<void> = $state(Promise.resolve());
</script>

<div class="relative flex w-full items-center justify-center text-center align-middle">
  {#await quoteRequest}
    <div
      data-testid="quote-loading"
      class="relative h-6 w-full rounded border border-gray-200 bg-white px-2 text-xs leading-6 font-semibold text-gray-500"
    >
      Quote
    </div>
  {:then _}
    <!-- Button gradually shows how long until it is expired by fill background -->
    {#if quoteExpires !== 0}
      <div
        class="absolute top-0 left-0 h-6 rounded bg-sky-100 transition-all"
        style="width: {width}%"
      ></div>
      <button
        data-testid="quote-button"
        class="relative h-6 w-full cursor-pointer rounded border border-gray-200 bg-white px-2 text-xs font-semibold text-gray-700 hover:border-sky-300 hover:text-sky-700"
        onclick={updateQuote}>Quote</button
      >
    {:else}
      <div
        class="absolute top-0 left-0 h-6 rounded bg-rose-100 transition-all"
        style="width: 100%"
      ></div>
      <button
        data-testid="quote-button"
        class="relative h-6 w-full cursor-pointer rounded border border-rose-200 bg-white px-2 text-xs font-semibold text-rose-700 hover:border-rose-300"
        onclick={updateQuote}>No Quote</button
      >
    {/if}
  {/await}
</div>
