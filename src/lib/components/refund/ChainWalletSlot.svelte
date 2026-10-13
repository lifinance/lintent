<script lang="ts">
  import store from "$lib/state.svelte";
  import { connectWith, listWalletConnectors } from "$lib/utils/wagmi";
  import { connectTronLink, isTronLinkAvailable } from "$lib/tron/signer";
  import {
    connectSolanaWallet,
    isSolanaWalletDetected,
    watchSolanaWallets,
    type SolanaWalletOption
  } from "$lib/solana/wallet";
  import { getChainType } from "$lib/utils/chainType";
  import { chainLabel } from "$lib/libraries/refundState";

  let {
    chainId,
    role,
    sameAsOrigin = false
  }: {
    chainId: bigint;
    role: "Origin" | "Destination" | "Publication" | "Proof / refund";
    sameAsOrigin?: boolean;
  } = $props();

  const vm = $derived(getChainType(chainId));
  const connected = $derived(store.accountDisplayForChain(chainId));
  let connecting = $state(false);
  let connectError = $state<string | null>(null);

  const connectors = listWalletConnectors();
  let solanaWallets = $state<SolanaWalletOption[]>([]);
  $effect(() => watchSolanaWallets((wallets) => (solanaWallets = wallets)));
  const availableSolanaWallets = $derived(solanaWallets.filter(isSolanaWalletDetected));

  async function connect(run: () => Promise<void>) {
    connecting = true;
    connectError = null;
    try {
      await run();
    } catch (error) {
      connectError = error instanceof Error ? error.message : String(error);
    } finally {
      connecting = false;
    }
  }

  const buttonClass =
    "cursor-pointer rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50";
</script>

<div class="flex flex-wrap items-center justify-between gap-2 text-xs">
  <span class="text-gray-500">
    {role} · <span class="font-medium text-gray-700">{chainLabel(chainId)}</span>
  </span>
  {#if sameAsOrigin}
    <span class="text-gray-500">Same EVM wallet — the network switches automatically</span>
  {:else if connected}
    <span class="rounded bg-emerald-50 px-2 py-0.5 font-mono text-emerald-700">
      ✓ {connected.slice(0, 6)}…{connected.slice(-4)} connected
    </span>
  {:else if vm === "evm"}
    <div class="flex flex-wrap gap-1">
      {#each connectors as connector (connector.id)}
        <button
          class={buttonClass}
          disabled={connecting}
          onclick={() => connect(() => connectWith(connector.id).then(() => undefined))}
        >
          {connectors.length === 1 ? "Connect EVM wallet" : connector.name}
        </button>
      {/each}
    </div>
  {:else if vm === "tron"}
    {#if isTronLinkAvailable()}
      <button
        class={buttonClass}
        disabled={connecting}
        onclick={() =>
          connect(async () => {
            store.tronWalletConnection = await connectTronLink();
          })}
      >
        {connecting ? "Connecting…" : "Connect TronLink"}
      </button>
    {:else}
      <a class="text-sky-700 hover:underline" href="https://www.tronlink.org/" target="_blank">
        Install TronLink
      </a>
    {/if}
  {:else if availableSolanaWallets.length > 0}
    <div class="flex flex-wrap gap-1">
      {#each availableSolanaWallets as wallet (wallet.name)}
        <button
          class={buttonClass}
          disabled={connecting}
          onclick={() =>
            connect(async () => {
              store.solanaWalletConnection = await connectSolanaWallet(wallet.name);
            })}
        >
          Connect {wallet.name}
        </button>
      {/each}
    </div>
  {:else}
    <span class="text-gray-400">No Solana wallet detected</span>
  {/if}
</div>
{#if connectError}
  <p class="mt-1 text-xs text-rose-600">{connectError}</p>
{/if}
