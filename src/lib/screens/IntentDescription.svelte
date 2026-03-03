<script lang="ts">
	let { scroll }: { scroll: (direction: boolean | number) => () => void } = $props();
</script>

<div class="h-[29rem] w-[25rem] flex-shrink-0 snap-center snap-always p-4 px-10">
	<h1 class="mb-1 w-full text-center text-2xl font-medium text-gray-900">Intent Description</h1>
	<p class="mb-2 text-center text-xs leading-relaxed text-gray-500">
		To fill an intent, you may need to execute up to 4 transactions. This intent requires 3.
	</p>
	<hr />
	<ol class="list-decimal">
		<li>
			<button class="cursor-pointer bg-green-100 hover:bg-green-200" onclick={scroll(1)}>
				The intent has been filled.
			</button>
		</li>
		<li>
			<button class="cursor-pointer bg-yellow-100 hover:bg-yellow-200" onclick={scroll(2)}>
				The intent does not need to be submitted.
			</button>
		</li>
		<li>
			<button class="cursor-pointer bg-red-100 hover:bg-red-200" onclick={scroll(3)}>
				The fill proof has not been proven.
			</button>
		</li>
		<li>
			<button class="cursor-pointer bg-red-100 hover:bg-red-200" onclick={scroll(4)}>
				The intent has not been finalised.
			</button>
		</li>
	</ol>
</div>
