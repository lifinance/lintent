<script lang="ts">
  import AwaitButton from "../components/AwaitButton.svelte";
  import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
  import SectionCard from "$lib/components/ui/SectionCard.svelte";
  import ChainActionRow from "$lib/components/ui/ChainActionRow.svelte";
  import TokenAmountChip from "$lib/components/ui/TokenAmountChip.svelte";

  import { Solver } from "$lib/libraries/solver";
  import type { OrderContainer } from "@lifi/intent";
  import { formatTokenAmount, getChainName, getCoin } from "$lib/config";
  import { idToToken } from "@lifi/intent";
  import store from "$lib/state.svelte";
  import { containerToIntent } from "$lib/utils/intent";
  import { hashStruct } from "viem";
  import { compactTypes } from "@lifi/intent";
  import { getInputChainTerminalStatus, type TerminalStatus } from "$lib/libraries/flowProgress";

  let {
    orderContainer,
    account,
    preHook,
    postHook
  }: {
    orderContainer: OrderContainer;
    preHook?: (chainId: number) => Promise<any>;
    postHook?: () => Promise<any>;
    account: () => `0x${string}`;
  } = $props();

  let refreshClaimed = $state(0);
  // Per input chain: which terminal state was reached. "refunded" is terminal but is
  // NOT a success — the solver already paid out on the output chain and got nothing
  // back. With Hyperlane's asynchronous relay this is a live risk, so a refund is
  // reported distinctly instead of being folded into "finalised".
  let claimedByChain = $state<Record<string, TerminalStatus | undefined>>({});
  let claimStatusRun = 0;
  const inputChains = $derived(containerToIntent(orderContainer).inputChains());
  const getInputsForChain = (container: OrderContainer, inputChain: bigint): [bigint, bigint][] => {
    const { order } = container;
    if ("originChainId" in order) {
      return order.originChainId === inputChain ? order.inputs : [];
    }
    return order.inputs.find((chainInput) => chainInput.chainId === inputChain)?.inputs ?? [];
  };
  const allClaimed = $derived(
    inputChains.length > 0 &&
      inputChains.every((chainId) => claimedByChain[chainId.toString()] === "claimed")
  );
  const anyRefunded = $derived(
    inputChains.some((chainId) => claimedByChain[chainId.toString()] === "refunded")
  );
  const confettiPieces = Array.from({ length: 28 }, (_, i) => ({
    left: (i * 13) % 100,
    delay: (i % 9) * 0.18,
    duration: 2.8 + (i % 5) * 0.35,
    rotation: (i * 47) % 360,
    hue: (i * 29) % 360
  }));

  const postHookRefreshValidate = async () => {
    if (postHook) await postHook();
    refreshClaimed += 1;
  };

  const outputKey = (output: (typeof orderContainer.order.outputs)[number]) =>
    hashStruct({
      data: output,
      types: compactTypes,
      primaryType: "MandateOutput"
    });

  const fillTransactionHashesFor = (container: OrderContainer) =>
    container.order.outputs.map((output) => store.fillTransactions[outputKey(output)]);

  const isValidFillTxHash = (hash: unknown): hash is `0x${string}` =>
    typeof hash === "string" && hash.startsWith("0x") && hash.length === 66;

  $effect(() => {
    refreshClaimed;
    const currentRun = ++claimStatusRun;
    Promise.all(
      inputChains.map(
        async (inputChain) =>
          [
            inputChain.toString(),
            // Single source of truth, shared with the flow-progress tracker.
            await getInputChainTerminalStatus(inputChain, orderContainer)
          ] as const
      )
    )
      .then((entries) => {
        if (currentRun !== claimStatusRun) return;
        const next: Record<string, TerminalStatus> = {};
        for (const [key, value] of entries) next[key] = value;
        claimedByChain = next;
      })
      .catch((e) => {
        console.warn("claim status refresh failed", e);
        if (currentRun !== claimStatusRun) return;
        const next: Record<string, TerminalStatus> = {};
        for (const chain of inputChains) next[chain.toString()] = "pending";
        claimedByChain = next;
      });
  });
</script>

<ScreenFrame title="Finalise Intent" description="Finalise the order to receive the input assets.">
  <div class="relative space-y-2">
    {#if allClaimed}
      <div class="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden="true">
        {#each confettiPieces as piece, i}
          <div
            class="confetti-piece"
            style={`left:${piece.left}%; animation-delay:${piece.delay}s; animation-duration:${piece.duration}s; --confetti-rotation:${piece.rotation}deg; --confetti-color:hsl(${piece.hue} 92% 62%);`}
          ></div>
        {/each}
      </div>
    {/if}
    {#if allClaimed}
      <div
        class="relative overflow-hidden rounded border border-emerald-200 bg-gradient-to-r from-emerald-50 via-sky-50 to-emerald-50 px-3 py-2"
      >
        <div class="text-center text-sm font-semibold text-emerald-800">All inputs finalised</div>
        <div class="text-center text-xs text-emerald-700">Intent fully solved.</div>
      </div>
    {/if}
    {#if anyRefunded}
      <!-- Terminal, but a loss: the inputs went back to the sponsor even though the
           outputs were filled. Never dressed up as a success. -->
      <div class="relative overflow-hidden rounded border border-red-200 bg-red-50 px-3 py-2">
        <div class="text-center text-sm font-semibold text-red-800">Inputs refunded</div>
        <div class="text-center text-xs text-red-700">
          The order was refunded to the sponsor after the outputs were filled — the attestation did
          not land before the deadline. This is a loss, not a completed solve.
        </div>
      </div>
    {/if}
    {#each inputChains as inputChain}
      <SectionCard compact>
        <ChainActionRow chainLabel={getChainName(inputChain)}>
          {#snippet action()}
            {@const terminalStatus = claimedByChain[inputChain.toString()]}
            {#if terminalStatus === undefined}
              <button
                type="button"
                class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
                disabled
              >
                Finalise
              </button>
            {:else if terminalStatus === "claimed"}
              <button
                type="button"
                class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
                disabled
              >
                Finalised
              </button>
            {:else if terminalStatus === "refunded"}
              <button
                type="button"
                class="h-8 rounded border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-700"
                disabled
              >
                Refunded
              </button>
            {:else}
              {@const fillTransactionHashes = fillTransactionHashesFor(orderContainer)}
              {@const canClaim = fillTransactionHashes.every((hash) => isValidFillTxHash(hash))}
              {#if !canClaim}
                <button
                  type="button"
                  class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
                  disabled
                >
                  Await fills
                </button>
              {:else}
                <AwaitButton
                  buttonFunction={Solver.claim(
                    store.walletClient,
                    {
                      sourceChainId: Number(inputChain),
                      orderContainer,
                      fillTransactionHashes: fillTransactionHashes as string[]
                    },
                    {
                      account,
                      preHook,
                      postHook: postHookRefreshValidate
                    }
                  )}
                >
                  {#snippet name()}
                    Claim
                  {/snippet}
                  {#snippet awaiting()}
                    Waiting for transaction...
                  {/snippet}
                </AwaitButton>
              {/if}
            {/if}
          {/snippet}
          {#snippet chips()}
            {#each getInputsForChain(orderContainer, inputChain) as input}
              <TokenAmountChip
                amountText={formatTokenAmount(
                  input[1],
                  getCoin({
                    address: idToToken(input[0]),
                    chainId: inputChain
                  }).decimals
                )}
                symbol={getCoin({
                  address: idToToken(input[0]),
                  chainId: inputChain
                }).name}
                tone="neutral"
              />
            {/each}
          {/snippet}
        </ChainActionRow>
      </SectionCard>
    {/each}
  </div>
</ScreenFrame>

<style>
  .confetti-piece {
    position: absolute;
    top: -12%;
    width: 0.4rem;
    height: 0.85rem;
    background: var(--confetti-color);
    border-radius: 2px;
    opacity: 0.9;
    transform: rotate(var(--confetti-rotation));
    animation-name: confetti-fall;
    animation-timing-function: linear;
    animation-iteration-count: infinite;
  }

  @keyframes confetti-fall {
    0% {
      transform: translate3d(0, -10%, 0) rotate(0deg);
      opacity: 0;
    }
    10% {
      opacity: 0.95;
    }
    100% {
      transform: translate3d(0, 1200%, 0) rotate(700deg);
      opacity: 0;
    }
  }
</style>
