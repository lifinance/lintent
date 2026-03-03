<script lang="ts">
	import {
		ALWAYS_OK_ALLOCATOR,
		POLYMER_ALLOCATOR,
		type Token,
		coinList,
		printToken
	} from "$lib/config";
	import BalanceField from "$lib/components/BalanceField.svelte";
	import AwaitButton from "$lib/components/AwaitButton.svelte";
	import FormControl from "$lib/components/ui/FormControl.svelte";
	import SegmentedControl from "$lib/components/ui/SegmentedControl.svelte";
	import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
	import SectionCard from "$lib/components/ui/SectionCard.svelte";
	import { CompactLib } from "$lib/libraries/compactLib";
	import { toBigIntWithDecimals } from "@lifi/intent";
	import store from "$lib/state.svelte";

	let {
		scroll,
		preHook,
		postHook,
		account
	}: {
		scroll: (direction: boolean | number) => () => void;
		preHook: (chainId: number) => Promise<void>;
		postHook: () => Promise<void>;
		account: () => `0x${string}`;
	} = $props();

	let manageAssetAction: "deposit" | "withdraw" = $state("deposit");

	let inputNumber = $state<number>(1);

	let selectedTokenIndex = $state<number>(0);
	const token = $derived<Token>(coinList(store.mainnet)[selectedTokenIndex]);

	let allowance = $state(0n);
	const inputAmount = $derived(toBigIntWithDecimals(inputNumber, token.decimals));
	$effect(() => {
		// Check if allowances contain the chain.
		if (!store.allowances[token.chainId]) {
			allowance = 0n;
			return;
		}
		store.allowances[token.chainId][token.address].then((a) => {
			allowance = a;
		});
	});
</script>

<ScreenFrame
	title="Assets Management"
	description="Select input type for your intent and manage deposited tokens. When done, continue to the right. If you want to use TheCompact signatures, ensure your tokens are deposited before you continue."
>
	<div class="space-y-2">
		<SectionCard compact>
			<div class="flex items-center justify-between gap-2">
				<h2 class="text-sm font-medium text-gray-700">Network</h2>
				<SegmentedControl
					testIdPrefix="network"
					size="sm"
					options={[
						{ label: "Testnet", value: "testnet" },
						{ label: "Mainnet", value: "mainnet" }
					]}
					value={store.mainnet ? "mainnet" : "testnet"}
					onChange={(v) => (store.mainnet = v === "mainnet")}
				/>
			</div>
		</SectionCard>
		<SectionCard compact>
			<div class="flex items-center justify-between gap-2">
				<h2 class="text-sm font-medium text-gray-700">Input Type</h2>
				<SegmentedControl
					testIdPrefix="intent-type"
					size="sm"
					options={[
						{ label: "Compact Lock", value: "compact" },
						{ label: "Escrow", value: "escrow" }
					]}
					value={store.intentType}
					onChange={(v) => (store.intentType = v as "compact" | "escrow")}
				/>
			</div>
		</SectionCard>
		{#if store.intentType === "compact"}
			<SectionCard title="Compact Asset Operations">
				<div class="space-y-3">
					<div class="flex items-center justify-between gap-2">
						<h2 class="text-sm font-medium text-gray-700">Allocator</h2>
						<SegmentedControl
							testIdPrefix="allocator"
							size="sm"
							options={[
								{ label: "AlwaysYesAllocator", value: ALWAYS_OK_ALLOCATOR },
								{ label: "Polymer", value: POLYMER_ALLOCATOR }
							]}
							value={store.allocatorId}
							onChange={(v) => (store.allocatorId = v as typeof store.allocatorId)}
						/>
					</div>
					<div class="flex flex-wrap items-center justify-start gap-2">
						<FormControl as="select" id="in-asset" bind:value={manageAssetAction}>
							<option value="deposit" selected>Deposit</option>
							<option value="withdraw">Withdraw</option>
						</FormControl>
						<FormControl type="number" className="w-20" bind:value={inputNumber} />
						<span>of</span>
						{#if (manageAssetAction === "withdraw" ? store.compactBalances : store.balances)[token.chainId]}
							<BalanceField
								value={(manageAssetAction === "withdraw" ? store.compactBalances : store.balances)[
									token.chainId
								][token.address]}
								decimals={token.decimals}
							/>
						{/if}
						<FormControl as="select" id="inputToken" bind:value={selectedTokenIndex}>
							{#each coinList(store.mainnet) as tkn, i}
								<option value={i}>{printToken(tkn)}</option>
							{/each}
						</FormControl>
					</div>
					<div class="flex justify-center">
						{#if manageAssetAction === "withdraw"}
							<AwaitButton
								buttonFunction={CompactLib.compactWithdraw(store.walletClient, {
									preHook,
									postHook,
									inputToken: { token, amount: inputAmount },
									account,
									allocatorId: store.allocatorId
								})}
							>
								{#snippet name()}
									Withdraw
								{/snippet}
								{#snippet awaiting()}
									Waiting for transaction...
								{/snippet}
							</AwaitButton>
						{:else if allowance < inputAmount}
							<AwaitButton
								buttonFunction={CompactLib.compactApprove(store.walletClient, {
									preHook,
									postHook,
									inputTokens: [{ token, amount: inputAmount }],
									account
								})}
							>
								{#snippet name()}
									Set allowance
								{/snippet}
								{#snippet awaiting()}
									Waiting for transaction...
								{/snippet}
							</AwaitButton>
						{:else}
							<AwaitButton
								buttonFunction={CompactLib.compactDeposit(store.walletClient!, {
									preHook,
									postHook,
									inputToken: { token, amount: inputAmount },
									account,
									allocatorId: store.allocatorId
								})}
							>
								{#snippet name()}
									Execute deposit
								{/snippet}
								{#snippet awaiting()}
									Waiting for transaction...
								{/snippet}
							</AwaitButton>
						{/if}
					</div>
				</div>
			</SectionCard>
		{:else}
			<SectionCard title="Escrow">
				<p>
					The Escrow Input Settler does not have any asset management. Skip to the next step to
					select which assets to use. In the future, this place will be updated to show your pending
					intents.
				</p>
			</SectionCard>
		{/if}
	</div>
</ScreenFrame>
