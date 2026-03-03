<div class="px-2">
	<p>
		This webapp demonstrates chain abstraction using the
		<a
			class="font-bold text-blue-700 hover:text-blue-500"
			href="https://github.com/openintentsframework/oif-contracts">Open Intents Framework</a
		>. It currently support a seamless resource lock flow using
		<a
			class="font-bold text-blue-700 hover:text-blue-500"
			href="https://github.com/Uniswap/the-compact/tree/v1">The Compact</a
		> and a traditional escrow flow, along with a work in progress multichain flow.
	</p>

	<br />

	<h3 class="font-semibold">Multichain</h3>
	<p>
		A multichain intent is an intent that collects inputs on multiple chains, providing the result
		on one or more chains. In other words, a multichain intent is an <i>any to any</i> intent.
		Multichain intents are currently work in progress and will break in the future. If you are using
		this interface for testing, ensure the <b>multichain</b> flag is not shown.
	</p>

	<br />

	<h3 class="font-semibold">Why Resource Locks?</h3>
	<p>
		Resource Locks improve asset availability guarantees in cross-chain contexts and asynchronous
		environments, offering several key advantages:
	</p>

	<ul class="list-inside list-disc">
		<li>Funds are only debited after successful delivery has been proven.</li>
		<li>
			Enables efficient short-lived interactions—intents can expire within seconds without
			consequence.
		</li>
		<li>No upfront deposit or initiation transaction are required.</li>
		<li>Fully composable with other protocols and settlement layers.</li>
	</ul>

	<p>
		Learn more about
		<a
			class="text-blue-700 hover:text-blue-500"
			href="https://docs.li.fi/lifi-intents/knowledge-database/resource-locks">Resource Locks</a
		>.
	</p>

	<br />

	<h3 class="font-semibold">Why the Open Intents Framework?</h3>
	<p>
		The Open Intents Framework (OIF) is an open coordination layer for standardizing and scaling
		intent-based workflows across chains. The goal is to:
	</p>

	<ul class="list-inside list-disc">
		<li>Standardise cross-chain interactions.</li>
		<li>Define a permissionless intent implementation that can scale across all chains.</li>
		<li>Create a reference implementation for cross-chain solvers & searchers.</li>
		<li>Provide tooling for wallet and app developers.</li>
	</ul>
	<p>
		Learn more about
		<a class="text-blue-700 hover:text-blue-500" href="https://openintents.xyz"
			>Open Intents Framework</a
		>.
	</p>

	<br />

	<h3 class="font-semibold">Same Chain</h3>
	<p>
		A same chain intent is an intent that only has inputs and outputs on the same chain. The oracle
		is configured different to a cross-chain intent. SetAttestation has to be called on the output
		settler to expose the filled output. Learm more about same chain intents or <a
			href="https://github.com/catalystsystem/catalyst-intent/blob/997649a2e2474d4c3e59afc631c6afd45a9040dc/test/integration/InputSettler7683LIFI.samechain.t.sol#L169-L174"
			>explore a demo</a
		> of how to collect inputs before delivering outputs.
	</p>
</div>
