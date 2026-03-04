<script lang="ts">
	import AwaitButton from "$lib/components/AwaitButton.svelte";
	import GetQuote from "$lib/components/GetQuote.svelte";
	import FormControl from "$lib/components/ui/FormControl.svelte";
	import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
	import SectionCard from "$lib/components/ui/SectionCard.svelte";
	import { POLYMER_ALLOCATOR, formatTokenAmount, getChainName } from "$lib/config";
	import { isAddress } from "viem";
	import { isValidSolanaAddress } from "$lib/utils/convert";
	import { IntentFactory, escrowApprove } from "$lib/libraries/intentFactory";
	import { CompactLib } from "$lib/libraries/compactLib";
	import store from "$lib/state.svelte";
	import InputTokenModal from "../components/InputTokenModal.svelte";
	import OutputTokenModal from "$lib/components/OutputTokenModal.svelte";
	import { ResetPeriod } from "@lifi/intent";
	import type { AppCreateIntentOptions } from "$lib/appTypes";
	import SolanaWalletButton from "$lib/components/SolanaWalletButton.svelte";

	const bigIntSum = (...nums: bigint[]) => nums.reduce((a, b) => a + b, 0n);
	const REQUIRED_INPUT_USDC_RAW = 100n;

	let {
		scroll,
		preHook,
		postHook,
		account
	}: {
		scroll: (direction: boolean | number) => () => void;
		preHook?: (chainId: number) => Promise<any>;
		postHook: () => Promise<void>;
		account: () => `0x${string}`;
	} = $props();

	let inputTokenSelectorActive = $state<boolean>(false);
	let outputTokenSelectorActive = $state<boolean>(false);
	const resolveExclusiveFor = (value: string): `0x${string}` | undefined =>
		isAddress(value, { strict: false }) ? value : undefined;

	const intentOptions = $derived.by(
		(): AppCreateIntentOptions => ({
			exclusiveFor: resolveExclusiveFor(store.exclusiveFor),
			inputTokens: store.inputTokens,
			outputTokens: store.outputTokens,
			verifier: store.verifier,
			lock:
				store.intentType === "compact"
					? {
							type: "compact",
							allocatorId: store.allocatorId,
							resetPeriod: ResetPeriod.OneDay
						}
					: { type: "escrow" },
			account
		})
	);

	const approvalOptions = $derived({
		preHook,
		postHook,
		inputTokens: store.inputTokens,
		account
	});

	const postHookScroll = async () => {
		await postHook();
		scroll(2)();
	};

	const intentFactory = $derived(
		new IntentFactory({
			mainnet: store.mainnet,
			walletClient: store.walletClient,
			preHook,
			postHook: postHookScroll,
			ordersPointer: store.orders
		})
	);

	const approveFunction = $derived(
		store.intentType === "compact"
			? CompactLib.compactApprove(store.walletClient, approvalOptions)
			: escrowApprove(store.walletClient, approvalOptions)
	);

	let allowanceCheck = $state(true);
	$effect(() => {
		allowanceCheck = true;
		if (!store.allowances[store.inputTokens[0].token.chainId]) {
			allowanceCheck = false;
			return;
		}
		for (let i = 0; i < store.inputTokens.length; ++i) {
			const { token, amount } = store.inputTokens[i];
			store.allowances[token.chainId][token.address].then((a) => {
				allowanceCheck = allowanceCheck && a >= amount;
			});
		}
	});
	let balanceCheckWallet = $state(true);
	$effect(() => {
		balanceCheckWallet = true;
		if (!store.balances[store.inputTokens[0].token.chainId]) {
			balanceCheckWallet = false;
			return;
		}
		for (let i = 0; i < store.inputTokens.length; ++i) {
			const { token, amount } = store.inputTokens[i];
			store.balances[token.chainId][token.address].then((b) => {
				balanceCheckWallet = balanceCheckWallet && b >= amount;
			});
		}
	});
	let balanceCheckCompact = $state(true);
	$effect(() => {
		balanceCheckCompact = true;
		if (!store.compactBalances[store.inputTokens[0].token.chainId]) {
			balanceCheckCompact = false;
			return;
		}
		for (let i = 0; i < store.inputTokens.length; ++i) {
			const { token, amount } = store.inputTokens[i];
			store.compactBalances[token.chainId][token.address].then((b) => {
				balanceCheckCompact = balanceCheckCompact && b >= amount;
			});
		}
	});

	const abstractInputs = $derived.by(() => {
		const inputs: {
			name: string;
			amount: bigint;
			decimals: number;
			chains: string[];
		}[] = [];
		const allUniqueNames = [
			...new Set(
				store.inputTokens.map((v) => {
					return v.token.name;
				})
			)
		];
		for (let i = 0; i < allUniqueNames.length; ++i) {
			const name = allUniqueNames[i];
			inputs[i] = {
				name,
				amount: bigIntSum(...store.inputTokens.map((v) => (v.token.name == name ? v.amount : 0n))),
				decimals: store.inputTokens.find((v) => v.token.name == name)!.token.decimals,
				chains: [
					...new Set(
						store.inputTokens
							.filter((v) => v.token.name == name)
							.map((v) => getChainName(v.token.chainId))
					)
				]
			};
		}
		return inputs;
	});

	const numInputChains = $derived.by(() => {
		const tokenChains = store.inputTokens.map(({ token }) => token.chainId);
		const uniqueChains = [...new Set(tokenChains)];
		return uniqueChains.length;
	});

	const hasEvmOutput = $derived(store.outputTokens.some(({ token }) => token.chainId !== 11));
	const hasSolanaOutput = $derived(store.outputTokens.some(({ token }) => token.chainId === 11));

	const evmRecipientValid = $derived(
		!hasEvmOutput ||
			store.recipient.trim().length === 0 ||
			isAddress(store.recipient, { strict: false })
	);
	const solanaRecipientValid = $derived(
		!hasSolanaOutput ||
			store.solanaRecipient.trim().length === 0 ||
			isValidSolanaAddress(store.solanaRecipient)
	);
	const recipientValid = $derived(evmRecipientValid && solanaRecipientValid);

	const sameChain = $derived.by(() => {
		if (numInputChains > 1) return false;
		const inputChain = store.inputTokens[0].token.chainId;
		const outputChains = store.outputTokens.map((o) => o.token.chainId);
		const numOutputChains = [...new Set(outputChains)].length;
		if (numOutputChains > 1) return false;
		const outputChain = outputChains[0];
		return inputChain === outputChain;
	});

	// const inputSecurityCheck = $derived.by(() => {
	// 	if (store.inputTokens.length === 0) return false;
	// 	const usdcOnly = store.inputTokens.every(({ token }) => token.name.toLowerCase() === "usdc");
	// 	if (!usdcOnly) return false;
	// 	const totalInput = store.inputTokens.reduce((sum, token) => sum + token.amount, 0n);
	// 	return totalInput === REQUIRED_INPUT_USDC_RAW;
	// });
</script>

<ScreenFrame
	title="Intent Issuance"
	description="Configure assets and execution settings, then issue your intent."
	contentClass="relative p-3"
	bodyClass="mt-2 h-[22.25rem] overflow-y-auto pr-1"
>
	{#if inputTokenSelectorActive}
		<InputTokenModal
			bind:active={inputTokenSelectorActive}
			bind:currentInputTokens={store.inputTokens}
		></InputTokenModal>
	{/if}
	{#if outputTokenSelectorActive}
		<OutputTokenModal
			bind:active={outputTokenSelectorActive}
			bind:currentOutputTokens={store.outputTokens}
		></OutputTokenModal>
	{/if}

	<div class="space-y-2">
		<SectionCard title="Intent pair" compact>
			{#snippet headerRight()}
				<div class="w-20">
					<GetQuote
						bind:exclusiveFor={store.exclusiveFor}
						useExclusiveForQuoteRequest={store.useExclusiveForQuoteRequest}
						mainnet={store.mainnet}
						inputTokens={store.inputTokens}
						bind:outputTokens={store.outputTokens}
						{account}
						recipient={() =>
							evmRecipientValid && store.recipient.length > 0
								? (store.recipient as `0x${string}`)
								: undefined}
					></GetQuote>
				</div>
			{/snippet}
			<div class="flex w-full flex-row justify-evenly gap-2">
				<div class="flex flex-col justify-center space-y-1">
					<h2 class="text-center text-xs font-semibold text-gray-500">You Pay</h2>
					{#each abstractInputs as input, i (input.name)}
						<button
							data-testid={`open-input-modal-${i}`}
							class="h-14 w-28 cursor-pointer rounded border border-gray-200 bg-white px-2 py-1 text-center transition-shadow ease-linear hover:shadow-md"
							onclick={() => (inputTokenSelectorActive = true)}
						>
							<div class="flex flex-col items-center justify-center align-middle">
								<div class="flex flex-row space-x-1">
									<div>{formatTokenAmount(input.amount, input.decimals)}</div>
									<div class="text-xs font-medium text-gray-600">{input.name.toUpperCase()}</div>
								</div>
								<div class="mt-0.5 text-center text-[11px] leading-tight text-gray-500">
									{#each input.chains as chainName, chainIndex (chainName)}
										<span>{chainName}{chainIndex < input.chains.length - 1 ? ", " : ""}</span>
									{/each}
								</div>
							</div>
						</button>
					{/each}
					{#if numInputChains > 1}
						<div class="text-center text-xs font-semibold text-amber-700">Multichain</div>
					{/if}
					{#if sameChain}
						<div class="text-center text-xs font-semibold text-sky-700">Same chain</div>
					{/if}
				</div>
				<div class="flex flex-col justify-center">
					<div class="flex flex-col items-center text-xs font-semibold text-gray-500">
						<div>In</div>
						<div>exchange</div>
						<div>for</div>
					</div>
				</div>
				<div class="flex flex-col justify-center space-y-1">
					<h2 class="text-center text-xs font-semibold text-gray-500">You Receive</h2>
					{#each store.outputTokens as outputToken, i (`${outputToken.token.chainId}-${outputToken.token.address}-${i}`)}
						<button
							data-testid={`open-output-modal-${i}`}
							class="h-14 w-28 cursor-pointer rounded border border-gray-200 bg-white px-2 py-1 text-center transition-shadow ease-linear hover:shadow-md"
							onclick={() => (outputTokenSelectorActive = true)}
						>
							<div class="flex flex-col items-center justify-center align-middle">
								<div class="flex flex-row space-x-1">
									<div>{formatTokenAmount(outputToken.amount, outputToken.token.decimals)}</div>
									<div class="text-xs font-medium text-gray-600">
										{outputToken.token.name.toUpperCase()}
									</div>
								</div>
								<div class="mt-0.5 text-[11px] leading-tight text-gray-500">
									{getChainName(outputToken.token.chainId)}
								</div>
							</div>
						</button>
					{/each}
				</div>
			</div>
		</SectionCard>

		<SectionCard compact>
			<div class="flex flex-col gap-2">
				<div class="flex items-center gap-1.5">
					<span class="text-[11px] font-semibold whitespace-nowrap text-gray-500"
						>Solana Wallet</span
					>
					<SolanaWalletButton />
				</div>
				<div class="flex min-w-0 items-center gap-1">
					<span
						class="text-[11px] font-semibold whitespace-nowrap {hasEvmOutput
							? 'text-gray-500'
							: 'text-gray-300'}">EVM Recipient</span
					>
					<FormControl
						type="text"
						size="sm"
						className="flex-1"
						placeholder="0x... (defaults to connected wallet)"
						disabled={!hasEvmOutput}
						state={!hasEvmOutput
							? "disabled"
							: store.recipient.length > 0 && !evmRecipientValid
								? "error"
								: "default"}
						bind:value={store.recipient}
					/>
				</div>
				<div class="flex min-w-0 items-center gap-1">
					<span
						class="text-[11px] font-semibold whitespace-nowrap {hasSolanaOutput
							? 'text-gray-500'
							: 'text-gray-300'}">Solana Recipient</span
					>
					<FormControl
						type="text"
						size="sm"
						className="flex-1"
						placeholder="Base58 address..."
						disabled={!hasSolanaOutput}
						state={!hasSolanaOutput
							? "disabled"
							: store.solanaRecipient.length > 0 && !solanaRecipientValid
								? "error"
								: "default"}
						bind:value={store.solanaRecipient}
					/>
				</div>
				<div class="flex items-center gap-1">
					<span class="text-[11px] font-semibold text-gray-500">Verifier</span>
					<FormControl as="select" id="verified-by" size="sm">
						<option value="polymer" selected>Polymer</option>
						<option value="wormhole" disabled>Wormhole</option>
					</FormControl>
				</div>
				<div class="flex min-w-0 items-center gap-1">
					<span class="text-[11px] font-semibold whitespace-nowrap text-gray-500">Exclusive</span>
					<FormControl
						type="text"
						size="sm"
						className="flex-1"
						placeholder="0x... (optional)"
						bind:value={store.exclusiveFor}
					/>
					<label
						class="flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap text-gray-500"
					>
						<input
							type="checkbox"
							class="h-3.5 w-3.5 rounded border-gray-300 text-sky-600 focus:ring-sky-300"
							bind:checked={store.useExclusiveForQuoteRequest}
						/>
						Lock Exclusive
					</label>
				</div>
			</div>
		</SectionCard>

		<div class="mt-2 flex justify-center">
			{#if !recipientValid}
				<button
					type="button"
					class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
					disabled
				>
					{#if !evmRecipientValid && !solanaRecipientValid}
						Fix Recipients
					{:else if !evmRecipientValid}
						Fix EVM Recipient
					{:else}
						Enter Solana Recipient
					{/if}
				</button>
			{:else if !allowanceCheck && !hasSolanaInput}
				<AwaitButton buttonFunction={approveFunction}>
					{#snippet name()}
						Set allowance
					{/snippet}
					{#snippet awaiting()}
						Waiting for transaction...
					{/snippet}
				</AwaitButton>
			{:else}
				<div class="flex flex-row space-x-2">
					{#if !balanceCheckWallet}
						<button
							type="button"
							class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
							disabled
						>
							Low Balance
						</button>
					{:else if store.intentType === "escrow"}
						<AwaitButton buttonFunction={intentFactory.openIntent(intentOptions)}>
							{#snippet name()}
								Execute Open
							{/snippet}
							{#snippet awaiting()}
								Waiting for transaction...
							{/snippet}
						</AwaitButton>
					{/if}
					{#if store.intentType === "compact" && store.allocatorId !== POLYMER_ALLOCATOR}
						{#if !balanceCheckCompact}
							<button
								type="button"
								class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
								disabled
							>
								Low Compact Balance
							</button>
						{:else}
							<AwaitButton buttonFunction={intentFactory.compact(intentOptions)}>
								{#snippet name()}
									Sign Order
								{/snippet}
								{#snippet awaiting()}
									Waiting for transaction...
								{/snippet}
							</AwaitButton>
						{/if}
					{/if}
				</div>
			{/if}
		</div>
		{#if numInputChains > 1 && store.intentType !== "compact"}
			<p class="mx-auto mt-2 w-4/5 text-center text-xs text-gray-600">
				You'll need to open the order on {numInputChains} chains. Be prepared and do not interrupt the
				process.
			</p>
		{/if}
	</div>
</ScreenFrame>
