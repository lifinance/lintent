<script lang="ts">
	import { OrderServer } from "$lib/libraries/orderServer";
	import type { TokenContext } from "$lib/state.svelte";
	import { interval } from "rxjs";
	import { isAddress } from "viem";

	let {
		exclusiveFor = $bindable(),
		useExclusiveForQuoteRequest = false,
		inputTokens,
		outputTokens = $bindable(),
		account,
		recipient,
		mainnet
	}: {
		exclusiveFor: string;
		useExclusiveForQuoteRequest?: boolean;
		inputTokens: TokenContext[];
		outputTokens: TokenContext[];
		account: () => `0x${string}`;
		recipient: () => `0x${string}` | undefined;
		mainnet: boolean;
	} = $props();

	const toRawAddress = (value: string): `0x${string}` | undefined =>
		isAddress(value, { strict: false }) ? (value as `0x${string}`) : undefined;

	const orderServer = $derived(new OrderServer(mainnet));

	async function getQuoteAndSet() {
		try {
			const requestedExclusiveFor = useExclusiveForQuoteRequest
				? [toRawAddress(exclusiveFor)].filter(
						(value): value is `0x${string}` => value !== undefined
					)
				: undefined;

			const receiver = recipient() ?? account();
			const response = await orderServer.getQuotes({
				user: account(),
				userChain: inputTokens[0].token.chain,
				exclusiveFor: requestedExclusiveFor,
				inputs: inputTokens.map(({ token, amount }) => {
					return {
						sender: account(),
						asset: token.address,
						chain: token.chain,
						amount: amount
					};
				}),
				outputs: outputTokens.map(({ token }) => {
					return {
						receiver: receiver,
						asset: token.address,
						chain: token.chain,
						amount: 0n
					};
				})
			});
			if (response?.quotes?.length ?? 0) {
				const quote = response.quotes[0];
				quoteExpires = quote.validUntil ?? new Date().getTime() + 30 * 1000;
				if (quoteExpires < new Date().getTime()) quoteExpires = new Date().getTime() + 30 * 1000;
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

	$effect(() => {
		mainnet;
		setTimeout(() => {
			updateQuote();
		}, 1000);
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
