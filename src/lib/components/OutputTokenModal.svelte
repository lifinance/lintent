<script lang="ts">
	import FieldRow from "$lib/components/ui/FieldRow.svelte";
	import FormControl from "$lib/components/ui/FormControl.svelte";
	import { chainIdList, getChainName } from "$lib/config";
	import type { AppTokenContext } from "$lib/appTypes";
	import store from "$lib/state.svelte";
	import { toBigIntWithDecimals } from "@lifi/intent";

	let {
		active = $bindable(),
		currentOutputTokens = $bindable()
	}: {
		active: boolean;
		currentOutputTokens: AppTokenContext[];
	} = $props();

	const outputs = $state<{ chainId: number; name: string; amount: number }[]>(
		currentOutputTokens.map(({ token, amount }) => {
			return {
				chainId: token.chainId,
				name: token.name,
				amount: Number(amount) / 10 ** token.decimals
			};
		})
	);

	function getTokensForChain(chainId: number) {
		return store.availableTokens.filter((v) => v.chainId === chainId);
	}

	function save() {
		const nextOutputTokens = [];
		for (const output of outputs) {
			const { name, chainId, amount } = output;
			const token = store.availableTokens.find((v) => v.name == name && v.chainId === chainId);
			// Check if we found token.
			if (!token) {
				console.log(`Could not find ${name} on ${chainId}`);
				continue;
			}
			nextOutputTokens.push({
				token,
				amount: toBigIntWithDecimals(amount, token.decimals)
			});
		}

		currentOutputTokens = nextOutputTokens;
		active = false;
	}

	function add() {
		if (outputs.length == 3) return;
		outputs.push({
			chainId: outputs[outputs.length - 1].chainId,
			name: "usdc",
			amount: 0
		});
	}

	function remove() {
		if (outputs.length == 1) return;
		outputs.pop();
	}

	const rowColumns = "5.5rem minmax(0,1fr) 5.5rem";
</script>

<div
	data-testid="output-token-modal"
	class="absolute top-1/2 left-1/2 z-20 mx-auto h-[80%] max-h-[24rem] w-11/12 -translate-x-1/2 -translate-y-1/2 transform rounded-md border border-gray-200 bg-white shadow-lg"
>
	<div class="flex h-full flex-col">
		<div class="flex items-center justify-between border-b border-gray-200 px-3 py-2">
			<div>
				<h3 class="text-base font-semibold text-gray-800">Select Output</h3>
				<p class="text-xs text-gray-500">Configure one or more destination token outputs.</p>
			</div>
			<button
				data-testid="output-token-modal-close"
				class="h-7 w-7 cursor-pointer rounded border border-gray-200 bg-white text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-800"
				onclick={() => {
					active = false;
				}}
			>
				x
			</button>
		</div>

		<div class="flex min-h-0 flex-1 flex-col space-y-2 overflow-y-auto p-3">
			<div>
				<FieldRow columns={rowColumns} header>
					<div>Chain</div>
					<div>Amount</div>
					<div>Token</div>
				</FieldRow>
				<div>
					{#each outputs as output, rowIndex}
						<FieldRow columns={rowColumns} striped index={rowIndex}>
							<FormControl as="select" size="sm" bind:value={output.chainId}>
								{#each chainIdList(store.mainnet) as chainId}
									<option value={chainId}>{getChainName(chainId)}</option>
								{/each}
							</FormControl>
							<FormControl type="number" size="sm" bind:value={output.amount} />
							<FormControl as="select" size="sm" bind:value={output.name}>
								{#each getTokensForChain(output.chainId) as token}
									<option value={token.name}>{token.name.toUpperCase()}</option>
								{/each}
							</FormControl>
						</FieldRow>
					{/each}
				</div>
			</div>

			<div class="flex items-center gap-2">
				<button
					data-testid="output-token-remove"
					class="h-8 w-8 cursor-pointer rounded border border-rose-200 bg-rose-50 text-base font-semibold text-rose-700 hover:border-rose-300"
					onclick={remove}
				>
					-
				</button>
				<button
					data-testid="output-token-modal-save"
					class="h-8 flex-1 cursor-pointer rounded border border-gray-200 bg-white text-sm font-semibold text-gray-700 hover:border-sky-300 hover:text-sky-700"
					onclick={save}>Save Output Selection</button
				>
				<button
					data-testid="output-token-add"
					class="h-8 w-8 cursor-pointer rounded border border-emerald-200 bg-emerald-50 text-base font-semibold text-emerald-700 hover:border-emerald-300"
					onclick={add}
				>
					+
				</button>
			</div>
		</div>
	</div>
</div>
