<script lang="ts">
  import store from "$lib/state.svelte";
  import { connectWith, listWalletConnectors } from "$lib/utils/wagmi";
  import { isTronLinkAvailable, connectTronLink } from "$lib/tron/signer";
  import type { SolanaWalletOption } from "$lib/solana/wallet";
  import {
    connectSolanaWallet,
    isSolanaWalletDetected,
    watchSolanaWallets
  } from "$lib/solana/wallet";

  let connectingEvm = $state(false);
  let connectingTron = $state(false);
  let connectingSolana = $state(false);
  let showEvmDropdown = $state(false);
  let showSolanaDropdown = $state(false);

  const connectors = listWalletConnectors();

  // Subscribed rather than read once: see watchSolanaWallets. Returning the
  // unsubscribe makes Svelte tear the listeners down with the component.
  let solanaWallets = $state<SolanaWalletOption[]>([]);
  $effect(() => watchSolanaWallets((wallets) => (solanaWallets = wallets)));

  const availableSolanaWallets = $derived(solanaWallets.filter(isSolanaWalletDetected));

  async function onConnectEvm(connectorId: string) {
    try {
      connectingEvm = true;
      showEvmDropdown = false;
      await connectWith(connectorId);
    } catch (error) {
      console.warn("EVM connect failed", error);
    } finally {
      connectingEvm = false;
    }
  }

  async function onConnectTron() {
    try {
      connectingTron = true;
      const connection = await connectTronLink();
      store.tronWalletConnection = connection;
    } catch (error) {
      console.warn("TronLink connect failed", error);
    } finally {
      connectingTron = false;
    }
  }

  async function onConnectSolana(name: string) {
    try {
      connectingSolana = true;
      showSolanaDropdown = false;
      store.solanaWalletConnection = await connectSolanaWallet(name);
    } catch (error) {
      console.warn(`Solana connect failed for ${name}`, error);
    } finally {
      connectingSolana = false;
    }
  }

  function truncate(addr: string, len = 4): string {
    if (addr.length <= len * 2 + 2) return addr;
    return `${addr.slice(0, len + 2)}...${addr.slice(-len)}`;
  }
</script>

<div class="flex flex-wrap items-center justify-center gap-2 text-xs">
  {#if store.connectedAccount}
    <span class="rounded bg-green-50 px-2 py-0.5 text-green-700">
      EVM: {truncate(store.connectedAccount.address)}
    </span>
  {:else}
    <div class="relative">
      {#if connectors.length === 1}
        <button
          class="cursor-pointer rounded bg-sky-50 px-2 py-0.5 text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={connectingEvm}
          onclick={() => onConnectEvm(connectors[0].id)}
        >
          {connectingEvm ? "Connecting..." : "Connect EVM"}
        </button>
      {:else}
        <button
          class="cursor-pointer rounded bg-sky-50 px-2 py-0.5 text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={connectingEvm}
          onclick={() => (showEvmDropdown = !showEvmDropdown)}
        >
          {connectingEvm ? "Connecting..." : "Connect EVM"}
        </button>
        {#if showEvmDropdown}
          <div
            class="absolute top-full left-0 z-50 mt-1 rounded border border-gray-200 bg-white shadow-md"
          >
            {#each connectors as connector (connector.id)}
              <button
                class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-sky-50"
                onclick={() => onConnectEvm(connector.id)}
              >
                {connector.name}
              </button>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  <span class="text-gray-300">|</span>

  {#if store.tronConnectedAccount}
    <span class="rounded bg-green-50 px-2 py-0.5 text-green-700">
      Tron: {truncate(store.tronConnectedAccount.base58Address)}
    </span>
  {:else if isTronLinkAvailable()}
    <button
      class="cursor-pointer rounded bg-sky-50 px-2 py-0.5 text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={connectingTron}
      onclick={onConnectTron}
    >
      {connectingTron ? "Connecting..." : "Connect Tron"}
    </button>
  {:else}
    <span class="rounded bg-gray-50 px-2 py-0.5 text-gray-400"> Tron: No wallet </span>
  {/if}

  <span class="text-gray-300">|</span>

  {#if store.solanaConnectedAccount}
    <span class="rounded bg-green-50 px-2 py-0.5 text-green-700">
      Solana: {truncate(store.solanaConnectedAccount.base58Address)}
    </span>
  {:else if availableSolanaWallets.length === 1}
    <button
      class="cursor-pointer rounded bg-sky-50 px-2 py-0.5 text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={connectingSolana}
      onclick={() => onConnectSolana(availableSolanaWallets[0].name)}
    >
      {connectingSolana ? "Connecting..." : "Connect Solana"}
    </button>
  {:else if availableSolanaWallets.length > 1}
    <div class="relative">
      <button
        class="cursor-pointer rounded bg-sky-50 px-2 py-0.5 text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={connectingSolana}
        onclick={() => (showSolanaDropdown = !showSolanaDropdown)}
      >
        {connectingSolana ? "Connecting..." : "Connect Solana"}
      </button>
      {#if showSolanaDropdown}
        <div
          class="absolute top-full left-0 z-50 mt-1 rounded border border-gray-200 bg-white shadow-md"
        >
          {#each availableSolanaWallets as wallet (wallet.name)}
            <button
              class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs whitespace-nowrap text-gray-700 hover:bg-sky-50"
              onclick={() => onConnectSolana(wallet.name)}
            >
              {wallet.name}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <span class="rounded bg-gray-50 px-2 py-0.5 text-gray-400"> Solana: No wallet </span>
  {/if}
</div>
