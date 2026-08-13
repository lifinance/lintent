<script lang="ts">
  import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
  import { connectWith, listWalletConnectors, walletConnectProjectId } from "$lib/utils/wagmi";
  import { isTronLinkAvailable, connectTronLink } from "$lib/tron/signer";
  import type { SolanaWalletOption } from "$lib/solana/wallet";
  import { connectSolanaWallet, listSolanaWallets } from "$lib/solana/wallet";
  import store from "$lib/state.svelte";

  const connectors = listWalletConnectors();
  let connectingId = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);
  let tronLinkAvailable = $state(isTronLinkAvailable());

  const connectWallet = async (connectorId: string) => {
    try {
      connectingId = connectorId;
      errorMessage = null;
      await connectWith(connectorId);
    } catch (error) {
      console.warn(`connectWith failed for connector ${connectorId}`, error);
      errorMessage = "Could not connect wallet. Please try again.";
    } finally {
      connectingId = null;
    }
  };

  const connectTron = async () => {
    try {
      connectingId = "tronlink";
      errorMessage = null;
      const connection = await connectTronLink();
      store.tronWalletConnection = connection;
    } catch (error) {
      console.warn("connectTronLink failed", error);
      errorMessage = error instanceof Error ? error.message : "Could not connect TronLink.";
    } finally {
      connectingId = null;
    }
  };

  // The adapters report availability asynchronously (they wait for injection),
  // so this is loaded rather than read synchronously like TronLink's.
  let solanaWallets = $state<SolanaWalletOption[]>([]);
  $effect(() => {
    listSolanaWallets()
      .then((wallets) => (solanaWallets = wallets))
      .catch((error) => console.warn("listSolanaWallets failed", error));
  });

  const connectSolana = async (name: string) => {
    try {
      connectingId = `solana:${name}`;
      errorMessage = null;
      store.solanaWalletConnection = await connectSolanaWallet(name);
    } catch (error) {
      console.warn(`connectSolanaWallet failed for ${name}`, error);
      errorMessage = error instanceof Error ? error.message : `Could not connect ${name}.`;
    } finally {
      connectingId = null;
    }
  };
</script>

<ScreenFrame title="" description="" contentClass="px-0" bodyClass="h-full">
  <div class="flex h-full flex-col justify-center gap-3 px-4">
    {#each connectors as connector (connector.id)}
      <button
        type="button"
        class="w-full cursor-pointer rounded border border-gray-300 px-4 py-3 text-base font-semibold text-gray-700 hover:border-sky-500 hover:text-sky-700 disabled:cursor-not-allowed disabled:text-gray-400"
        disabled={connectingId !== null}
        onclick={() => connectWallet(connector.id)}
      >
        {#if connectingId === connector.id}
          Connecting {connector.name}...
        {:else}
          Connect {connector.name}
        {/if}
      </button>
    {/each}

    {#if tronLinkAvailable}
      <button
        type="button"
        class="w-full cursor-pointer rounded border border-gray-300 px-4 py-3 text-base font-semibold text-gray-700 hover:border-sky-500 hover:text-sky-700 disabled:cursor-not-allowed disabled:text-gray-400"
        disabled={connectingId !== null}
        onclick={() => connectTron()}
      >
        {#if connectingId === "tronlink"}
          Connecting TronLink...
        {:else if store.tronConnectedAccount}
          TronLink Connected ({store.tronConnectedAccount.base58Address.slice(0, 6)}...)
        {:else}
          Connect TronLink
        {/if}
      </button>
    {:else}
      <p class="text-center text-xs text-gray-400">
        TronLink not detected — install it to use Tron chains.
      </p>
    {/if}

    {#each solanaWallets as wallet (wallet.name)}
      <button
        type="button"
        class="w-full cursor-pointer rounded border border-gray-300 px-4 py-3 text-base font-semibold text-gray-700 hover:border-sky-500 hover:text-sky-700 disabled:cursor-not-allowed disabled:text-gray-400"
        disabled={connectingId !== null || wallet.readyState === "NotDetected"}
        onclick={() => connectSolana(wallet.name)}
      >
        {#if connectingId === `solana:${wallet.name}`}
          Connecting {wallet.name}...
        {:else if store.solanaConnectedAccount && store.solanaWalletConnection.address}
          {wallet.name} Connected ({store.solanaConnectedAccount.base58Address.slice(0, 6)}...)
        {:else if wallet.readyState === "NotDetected"}
          {wallet.name} not detected
        {:else}
          Connect {wallet.name}
        {/if}
      </button>
    {/each}

    {#if !walletConnectProjectId}
      <p class="text-center text-xs text-gray-500">
        WalletConnect is disabled (missing `PUBLIC_WALLET_CONNECT_PROJECT_ID`).
      </p>
    {/if}
    {#if errorMessage}
      <p class="text-center text-sm text-red-600">{errorMessage}</p>
    {/if}
  </div>
</ScreenFrame>
