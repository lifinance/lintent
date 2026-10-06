<script lang="ts">
  import AwaitButton from "../components/AwaitButton.svelte";
  import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
  import SectionCard from "$lib/components/ui/SectionCard.svelte";
  import ChainActionRow from "$lib/components/ui/ChainActionRow.svelte";
  import TokenAmountChip from "$lib/components/ui/TokenAmountChip.svelte";

  import { Solver } from "$lib/libraries/solver";
  import type { OrderContainer } from "@lifi/intent";
  import { formatTokenAmount, getChainName, getCoin, isStellarChain } from "$lib/config";
  import { idToToken } from "@lifi/intent";
  import { toHex } from "viem";
  import store from "$lib/state.svelte";
  import { containerToIntent } from "$lib/utils/intent";
  import {
    getOutputStorageKey as outputKey,
    isInputChainFinalised
  } from "$lib/libraries/flowProgress";
  import { invalidateRpcPrefix } from "$lib/libraries/rpcCache";

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
  let claimedByChain = $state<Record<string, boolean>>({});
  let claimStatusRun = 0;
  const inputChains = $derived(containerToIntent(orderContainer).inputChains());
  const getInputsForChain = (container: OrderContainer, inputChain: bigint): [bigint, bigint][] => {
    const { order } = container;
    if ("originChainId" in order) {
      return BigInt(order.originChainId) === BigInt(inputChain) ? order.inputs : [];
    }
    return (
      order.inputs.find((chainInput) => BigInt(chainInput.chainId) === BigInt(inputChain))
        ?.inputs ?? []
    );
  };
  const allFinalised = $derived(
    inputChains.length > 0 &&
      inputChains.every((chainId) => claimedByChain[chainId.toString()] === true)
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
    invalidateRpcPrefix("progress:finalised:");
    refreshClaimed += 1;
  };

  const fillTransactionHashesFor = (container: OrderContainer) =>
    container.order.outputs.map((output) => store.fillTransactions[outputKey(output)]);

  const isValidFillTxHash = (hash: unknown): hash is `0x${string}` =>
    typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash);

  // Stellar input ids are raw 32-byte contract ids, not EVM token ids.
  // Orders reloaded from the DB carry bigints as decimal strings.
  const inputTokenAddress = (inputChain: bigint, tokenId: bigint) =>
    isStellarChain(inputChain) ? toHex(BigInt(tokenId), { size: 32 }) : idToToken(tokenId);

  $effect(() => {
    refreshClaimed;
    const currentRun = ++claimStatusRun;
    Promise.all(
      inputChains.map(
        async (inputChain) =>
          [inputChain.toString(), await isInputChainFinalised(inputChain, orderContainer)] as const
      )
    )
      .then((entries) => {
        if (currentRun !== claimStatusRun) return;
        const next: Record<string, boolean> = {};
        for (const [key, value] of entries) next[key] = value;
        claimedByChain = next;
      })
      .catch((e) => console.warn("claim status refresh failed", e));
  });
</script>

<ScreenFrame title="Finalise Intent" description="Finalise the order to receive the input assets.">
  <div class="relative space-y-2">
    {#if allFinalised}
      <div class="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden="true">
        {#each confettiPieces as piece, i}
          <div
            class="confetti-piece"
            style={`left:${piece.left}%; animation-delay:${piece.delay}s; animation-duration:${piece.duration}s; --confetti-rotation:${piece.rotation}deg; --confetti-color:hsl(${piece.hue} 92% 62%);`}
          ></div>
        {/each}
      </div>
    {/if}
    {#if allFinalised}
      <div
        class="relative overflow-hidden rounded border border-emerald-200 bg-gradient-to-r from-emerald-50 via-sky-50 to-emerald-50 px-3 py-2"
      >
        <div class="text-center text-sm font-semibold text-emerald-800">All inputs finalised</div>
        <div class="text-center text-xs text-emerald-700">Intent fully solved.</div>
      </div>
    {/if}
    {#each inputChains as inputChain}
      <SectionCard compact>
        <ChainActionRow chainLabel={getChainName(inputChain)}>
          {#snippet action()}
            {@const isClaimedStatus = claimedByChain[inputChain.toString()]}
            {#if isClaimedStatus === undefined}
              <button
                type="button"
                class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
                disabled
              >
                Finalise
              </button>
            {:else if isClaimedStatus}
              <button
                type="button"
                class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
                disabled
              >
                Finalised
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
                    address: inputTokenAddress(inputChain, input[0]),
                    chainId: inputChain
                  }).decimals
                )}
                symbol={getCoin({
                  address: inputTokenAddress(inputChain, input[0]),
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
