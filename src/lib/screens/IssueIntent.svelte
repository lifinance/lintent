<script lang="ts">
  import AwaitButton from "$lib/components/AwaitButton.svelte";
  import GetQuote from "$lib/components/GetQuote.svelte";
  import FormControl from "$lib/components/ui/FormControl.svelte";
  import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
  import SectionCard from "$lib/components/ui/SectionCard.svelte";
  import { POLYMER_ALLOCATOR, formatTokenAmount, getChainName } from "$lib/config";
  import { IntentFactory, escrowApprove } from "$lib/libraries/intentFactory";
  import { CompactLib } from "$lib/libraries/compactLib";
  import store from "$lib/state.svelte";
  import InputTokenModal from "../components/InputTokenModal.svelte";
  import OutputTokenModal from "$lib/components/OutputTokenModal.svelte";
  import { ResetPeriod } from "@lifi/intent";
  import type { AppCreateIntentOptions } from "$lib/appTypes";
  import { resolveAddressForChainType } from "$lib/utils/address";
  import { formatAddressForChain, getChainType } from "$lib/utils/chainType";

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

  // The exclusive solver is resolved against the INPUT chain's namespace, never
  // chain-agnostically: it is the input settler that pays the solver out, so it
  // is the input chain that has to recognise the identity. A 0x address padded
  // into a Solana-origin order names a key nobody can sign `finalise` with — the
  // order opens, escrows the input, gets filled, and can then never be settled.
  const inputChainType = $derived.by((): ReturnType<typeof getChainType> | undefined => {
    const inputChain = store.inputTokens[0]?.token.chainId;
    // A multichain order opens every component through the EVM wallet client,
    // so its inputs are all EVM and the first one speaks for the rest.
    return inputChain === undefined ? undefined : getChainType(inputChain);
  });

  const resolvedExclusiveFor = $derived.by((): `0x${string}` | undefined => {
    if (store.exclusiveFor.trim().length === 0 || inputChainType === undefined) return undefined;
    return resolveAddressForChainType(store.exclusiveFor, inputChainType);
  });

  const EXCLUSIVE_FOR_FORMAT_HINT: Record<ReturnType<typeof getChainType>, string> = {
    solana:
      "Exclusive solver must be a base58 Solana address — a 0x address would be padded into a key that cannot sign finalise, so the order could be filled but never settled.",
    tron: "Exclusive solver must be a Tron (T...) or 0x address.",
    evm: "Exclusive solver must be a 0x or Tron (T...) address — a Solana key is not an identity the input settler can pay out to."
  };

  const exclusiveForProblem = $derived.by((): string | undefined => {
    if (store.exclusiveFor.trim().length === 0) return undefined;
    if (resolvedExclusiveFor !== undefined) return undefined;
    return EXCLUSIVE_FOR_FORMAT_HINT[inputChainType ?? "evm"];
  });

  // Cross-namespace orders (e.g. EVM -> Tron) must name their recipient: the
  // default recipient is the source-chain account, which only a plain EOA key
  // can control on the destination namespace (a Safe or exchange address
  // cannot). The library rejects the order at build time; surface it here.
  const recipientRequired = $derived.by(() => {
    const inputChain = store.inputTokens[0]?.token.chainId;
    if (inputChain === undefined) return false;
    return store.outputTokens.some(
      (o) => getChainType(o.token.chainId) !== getChainType(inputChain)
    );
  });

  const outputChainTypes = $derived([
    ...new Set(store.outputTokens.map((o) => getChainType(o.token.chainId)))
  ]);

  // Resolved against the OUTPUT chain's namespace, never chain-agnostically:
  // `@lifi/intent` zero-pads a 20-byte EVM address into a Solana pubkey nobody
  // controls, and the EVM settler truncates a 32-byte Solana key to its low 20
  // bytes — either way a wrong-namespace recipient silently burns the output.
  const resolvedRecipient = $derived.by((): `0x${string}` | undefined => {
    if (store.recipient.trim().length === 0) return undefined;
    const resolutions = outputChainTypes.map((chainType) =>
      resolveAddressForChainType(store.recipient, chainType)
    );
    if (resolutions.length === 0 || resolutions.some((r) => r === undefined)) return undefined;
    // Distinct chain types resolve disjoint formats, so all-defined means
    // every entry is the same value.
    return resolutions[0];
  });

  const RECIPIENT_FORMAT_HINT: Record<ReturnType<typeof getChainType>, string> = {
    solana:
      "Recipient must be a base58 Solana address — a 0x address would be padded into a Solana key nobody controls.",
    tron: "Recipient must be a Tron (T...) or 0x address.",
    evm: "Recipient must be a 0x or Tron (T...) address — a Solana key would be truncated to 20 bytes on payout."
  };

  const recipientProblem = $derived.by((): string | undefined => {
    if (store.recipient.trim().length === 0) {
      return recipientRequired
        ? "This order pays out on a different chain type than it is opened on — enter a recipient address for the output chain."
        : undefined;
    }
    if (resolvedRecipient !== undefined) return undefined;
    if (outputChainTypes.length > 1) {
      return "No single recipient is valid on every output chain type — use outputs from one chain type.";
    }
    return RECIPIENT_FORMAT_HINT[outputChainTypes[0] ?? "evm"];
  });

  // Solana fills batch all of a chain's outputs into ONE transaction — the fill
  // reference stored per output must contain every output's OutputFilledEvent
  // (see fillOutputs in src/lib/solana/writes.ts) — and two exclusive outputs
  // already exceed Solana's 1232-byte transaction cap. Such an order opens,
  // escrows the inputs, and then can never be filled, so it is blocked here.
  const solanaOutputOverflow = $derived.by(() => {
    const perChain = new Map<number, number>();
    for (const { token } of store.outputTokens) {
      if (getChainType(token.chainId) !== "solana") continue;
      perChain.set(token.chainId, (perChain.get(token.chainId) ?? 0) + 1);
    }
    return [...perChain.values()].some((count) => count > 1);
  });

  const issueBlocker = $derived(
    recipientProblem ??
      exclusiveForProblem ??
      (solanaOutputOverflow
        ? "Solana orders support a single output: all outputs must be filled in one Solana transaction, and more than one exceeds the 1232-byte transaction size — the order would open but could never be filled."
        : undefined)
  );

  const intentOptions = $derived.by(
    (): AppCreateIntentOptions => ({
      // Whatever the quote named as its exclusive solver, in every mode. The
      // 1:1 demo used to substitute a hardcoded EVM solver here, which is not
      // an identity a Solana-origin order can ever settle to; the integrator
      // key is what drives the 1:1 quote, and the solver comes back on it.
      exclusiveFor: resolvedExclusiveFor,
      inputTokens: store.inputTokens,
      outputTokens: store.outputTokens,
      verifier: store.verifier,
      outputRecipient: resolvedRecipient,
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
      useProductionApi: store.useProductionApi,
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
      const allowancePromise = store.allowances[token.chainId]?.[token.address];
      if (!allowancePromise) {
        allowanceCheck = false;
        continue;
      }
      allowancePromise.then((a) => {
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
      const balancePromise = store.balances[token.chainId]?.[token.address];
      if (!balancePromise) {
        balanceCheckWallet = false;
        continue;
      }
      balancePromise.then((b) => {
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
      const compactBalancePromise = store.compactBalances[token.chainId]?.[token.address];
      if (!compactBalancePromise) {
        balanceCheckCompact = false;
        continue;
      }
      compactBalancePromise.then((b) => {
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
            use11Demo={store.use11Demo}
            integratorKey={store.integratorKey}
            mainnet={store.mainnet}
            useProductionApi={store.useProductionApi}
            inputTokens={store.inputTokens}
            bind:outputTokens={store.outputTokens}
            accountForChain={(chainId) => store.accountForChain(chainId)}
            outputRecipient={resolvedRecipient}
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
        <div class="flex min-w-0 items-center gap-1">
          <span class="text-[11px] font-semibold whitespace-nowrap text-gray-500">Recipient</span>
          <FormControl
            type="text"
            size="sm"
            className="flex-1"
            placeholder="0x... or T... (optional)"
            state={recipientProblem !== undefined ? "error" : "default"}
            bind:value={store.recipient}
          />
        </div>
        {#if resolvedRecipient !== undefined}
          <p class="text-[11px] break-all text-gray-500">
            Pays out to
            <span class="font-medium text-gray-600">
              {formatAddressForChain(resolvedRecipient, store.outputTokens[0].token.chainId)}
            </span>
            on {getChainName(store.outputTokens[0].token.chainId)}
          </p>
        {:else if recipientProblem !== undefined && store.recipient.trim().length > 0}
          <p class="text-[11px] text-red-600">{recipientProblem}</p>
        {/if}
        <div class="flex items-center gap-1">
          <span class="text-[11px] font-semibold text-gray-500">Verifier</span>
          {#if sameChain}
            <FormControl as="select" size="sm" state="disabled" disabled>
              <option selected disabled>Settler</option>
            </FormControl>
          {:else}
            <FormControl as="select" id="verified-by" size="sm">
              <option value="polymer" selected>Polymer</option>
              <option value="wormhole" disabled>Wormhole</option>
            </FormControl>
          {/if}
        </div>
        <div class="flex min-w-0 items-center gap-1">
          <span class="text-[11px] font-semibold whitespace-nowrap text-gray-500">Exclusive</span>
          <FormControl
            type="text"
            size="sm"
            className="flex-1"
            placeholder="0x / base58 (optional)"
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
        <div class="flex min-w-0 items-center gap-1">
          <label
            class="flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap text-gray-500"
          >
            <input
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-gray-300 text-sky-600 focus:ring-sky-300"
              bind:checked={store.use11Demo}
            />
            1:1 demo
          </label>
          {#if store.use11Demo}
            <FormControl
              type="text"
              size="sm"
              className="flex-1"
              placeholder="X-Integrator-Key"
              bind:value={store.integratorKey}
            />
          {/if}
        </div>
      </div>
    </SectionCard>

    <div class="mt-2 flex justify-center">
      {#if issueBlocker !== undefined}
        <!-- Before the allowance branch: an order that can never be issued
             must not prompt for an approval transaction first. -->
        <button
          type="button"
          class="h-8 rounded border border-amber-200 bg-amber-50 px-3 text-sm font-semibold text-amber-700"
          disabled
        >
          Cannot Issue
        </button>
      {:else if !allowanceCheck}
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
    {#if issueBlocker !== undefined}
      <p class="mx-auto mt-2 w-4/5 text-center text-xs font-medium text-amber-700">
        {issueBlocker}
      </p>
    {/if}
    {#if numInputChains > 1 && store.intentType !== "compact"}
      <p class="mx-auto mt-2 w-4/5 text-center text-xs text-gray-600">
        You'll need to open the order on {numInputChains} chains. Be prepared and do not interrupt the
        process.
      </p>
    {/if}
  </div>
</ScreenFrame>
