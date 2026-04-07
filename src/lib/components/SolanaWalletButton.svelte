<script lang="ts">
	import { AVAILABLE_WALLETS } from "$lib/utils/solana-wallet.svelte";
	import solanaWallet from "$lib/utils/solana-wallet.svelte";

	let selectedWalletIndex = $state(0);
	let connecting = $state(false);
	let error = $state<string | null>(null);

	const truncate = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;

	async function connect() {
		error = null;
		connecting = true;
		try {
			await solanaWallet.connect(AVAILABLE_WALLETS[selectedWalletIndex].adapter);
		} catch (e: unknown) {
			error = e instanceof Error ? e.message : "Connection failed";
		} finally {
			connecting = false;
		}
	}

	async function disconnect() {
		await solanaWallet.disconnect();
		error = null;
	}
</script>

{#if solanaWallet.connected && solanaWallet.publicKey}
	<div class="flex items-center gap-1">
		<span class="rounded bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
			◎ {truncate(solanaWallet.publicKey)}
		</span>
		<button class="cursor-pointer text-xs text-gray-400 hover:text-red-500" onclick={disconnect}>
			✕
		</button>
	</div>
{:else}
	<div class="flex items-center gap-1">
		<select
			class="rounded border border-gray-200 bg-white px-1 py-0.5 text-xs text-gray-700"
			bind:value={selectedWalletIndex}
		>
			{#each AVAILABLE_WALLETS as wallet, i (wallet.name)}
				<option value={i}>{wallet.name}</option>
			{/each}
		</select>
		<button
			class="cursor-pointer rounded border border-gray-200 bg-white px-2 py-0.5 text-xs font-medium text-gray-700 hover:border-sky-300 hover:text-sky-700 disabled:cursor-not-allowed disabled:text-gray-400"
			disabled={connecting}
			onclick={connect}
		>
			{connecting ? "Connecting…" : "Connect Solana"}
		</button>
	</div>
	{#if error}
		<p class="mt-0.5 text-xs text-red-500">{error}</p>
	{/if}
{/if}
