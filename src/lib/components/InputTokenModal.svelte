<script lang="ts">
  import { getChainName, type Token } from "$lib/config";
  import FieldRow from "$lib/components/ui/FieldRow.svelte";
  import FormControl from "$lib/components/ui/FormControl.svelte";
  import InlineMetaField from "$lib/components/ui/InlineMetaField.svelte";
  import { AssetSelection } from "$lib/libraries/assetSelection";
  import type { AppTokenContext } from "$lib/appTypes";
  import store from "$lib/state.svelte";
  import { toBigIntWithDecimals } from "@lifi/intent";
  import { type InteropableAddress, getInteropableAddress } from "@lifi/intent";

  const v = (num: number | null) => (num ? num : 0);
  const formatBalance = (value: bigint, decimals: number) =>
    (Number(value) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 4 });

  let {
    active = $bindable(),
    currentInputTokens = $bindable()
  }: {
    active: boolean;
    currentInputTokens: AppTokenContext[];
  } = $props();

  let inputs = $state<{ [index: InteropableAddress]: number | null }>(
    Object.fromEntries(
      (currentInputTokens ?? []).map(({ token, amount }) => [
        getInteropableAddress(token.address, token.chainId),
        Number(amount) / 10 ** token.decimals
      ])
    )
  );
  let enabledByToken = $state<{ [index: InteropableAddress]: boolean }>(
    Object.fromEntries(
      (currentInputTokens ?? []).map(({ token }) => [
        getInteropableAddress(token.address, token.chainId),
        true
      ])
    )
  );
  // svelte-ignore state_referenced_locally
  let computerValue = $state<number | null>(Object.values(inputs).reduce((a, b) => v(a) + v(b), 0));

  type SortOrder = "largest" | "smallest";
  let sortOrder = $state<SortOrder>("largest");
  const rowColumns = "4.5rem minmax(0,1fr) 2rem";
  const iaddrFor = (token: Token) => getInteropableAddress(token.address, token.chainId);

  const isEnabled = (address: InteropableAddress) => enabledByToken[address] ?? true;

  function getTokenFor(address: InteropableAddress): Token | undefined {
    for (const token of tokenSet) {
      const iaddr = iaddrFor(token);
      if (iaddr === address) return token;
    }
  }

  function save() {
    // Go over every single non-0 instance in the array:
    const inputKeys = Object.keys(inputs) as InteropableAddress[];
    const inputTokens: AppTokenContext[] = [];
    for (const key of inputKeys) {
      // Check that key is a number
      const inputValue = v(inputs[key]);
      // The token would be:
      const token = getTokenFor(key);
      // If we can't find the token, then it is most likely because the user changed their token.
      if (!token) continue;
      if (!isEnabled(key)) continue;

      if (inputValue === 0) continue;
      inputTokens.push({ token, amount: toBigIntWithDecimals(inputValue, token.decimals) });
    }
    if (inputTokens.length === 0) {
      inputTokens.push({ token: tokenSet[0], amount: 0n });
    }
    currentInputTokens = inputTokens;

    active = false;
  }

  const uniqueInputTokens = $derived([
    ...new Set(store.availableTokens.map((v) => v.name).filter((v) => v !== "eth"))
  ]);

  // svelte-ignore state_referenced_locally
  let selectedTokenName = $state<string>(currentInputTokens[0].token.name);
  const tokenSet = $derived(
    store.availableTokens.filter((v) => v.name.toLowerCase() === selectedTokenName.toLowerCase())
  );

  let circuitBreaker = false;
  $effect(() => {
    selectedTokenName;
    if (circuitBreaker || currentInputTokens[0].token.name !== selectedTokenName) {
      circuitBreaker = true;
      inputs = Object.fromEntries(tokenSet.map((token) => [iaddrFor(token), 0]));
      enabledByToken = Object.fromEntries(tokenSet.map((token) => [iaddrFor(token), true]));
    }
  });

  async function computeInputs(total: number, order: SortOrder) {
    const tokens = tokenSet;
    const selectedIndices = tokens
      .map((token, i) => [token, i] as const)
      .filter(([token]) => isEnabled(iaddrFor(token)))
      .map(([, i]) => i);
    if (selectedIndices.length === 0) {
      for (const token of tokens) {
        const iaddr = iaddrFor(token);
        inputs[iaddr] = 0;
      }
      return 0;
    }
    const balancePromises = selectedIndices.map(
      (i) =>
        (store.intentType === "compact" ? store.compactBalances : store.balances)[
          tokens[i].chainId
        ][tokens[i].address]
    );
    const balances = await Promise.all(balancePromises);

    const goal = toBigIntWithDecimals(total, tokens[0].decimals);
    const solution =
      AssetSelection.Sum(balances) < goal
        ? balances
        : order === "largest"
          ? new AssetSelection({ goal, values: balances }).largest().asValues()
          : new AssetSelection({ goal, values: balances }).smallest().asValues();

    for (const token of tokens) {
      const iaddr = iaddrFor(token);
      inputs[iaddr] = 0;
    }
    for (let i = 0; i < selectedIndices.length; ++i) {
      const token = tokenSet[selectedIndices[i]];
      const iaddr = iaddrFor(token);
      inputs[iaddr] = Number(solution[i]) / 10 ** token.decimals;
    }

    return Number(AssetSelection.Sum(solution)) / 10 ** tokens[0].decimals;
  }

  // svelte-ignore state_referenced_locally
  let lastComputed = $state<number | null>(computerValue);
  // svelte-ignore state_referenced_locally
  let lastSortOrder = $state<SortOrder>(sortOrder);

  // Only trigger computeInputs when the user actually changes `computerValue` or `sortOrder`.
  $effect(() => {
    if (computerValue === lastComputed && lastSortOrder === sortOrder) return;
    lastSortOrder = sortOrder;
    const requested = v(computerValue);
    computeInputs(requested, sortOrder).then(() => {
      // computeInputs updates `inputs`; the inputs-effect below will set
      // `computerValue` and `lastComputed` so we don't set them here.
    });
  });

  // Canonical source of truth: derive `computerValue` from `inputs`.
  $effect(() => {
    const sum = Object.values(inputs).reduce((a, b) => v(a) + v(b), 0) as number;
    lastComputed = sum;
    computerValue = sum;
  });
</script>

<div
  data-testid="input-token-modal"
  class="absolute top-1/2 left-1/2 z-20 mx-auto h-[80%] max-h-[24rem] w-11/12 -translate-x-1/2 -translate-y-1/2 transform rounded-md border border-gray-200 bg-white shadow-lg"
>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between border-b border-gray-200 px-3 py-2">
      <div>
        <h3 class="text-base font-semibold text-gray-800">Select Input</h3>
        <p class="text-xs text-gray-500">Choose token amount distribution across chains.</p>
      </div>
      <button
        data-testid="input-token-modal-close"
        class="h-7 w-7 cursor-pointer rounded border border-gray-200 bg-white text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-800"
        onclick={() => {
          active = false;
        }}
      >
        x
      </button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col space-y-2 overflow-y-auto p-3">
      <div class="flex items-center gap-1">
        <FormControl as="select" id="orderSelector" className="w-14" bind:value={sortOrder}>
          <option value="largest">↑</option>
          <option value="smallest">↓</option>
        </FormControl>
        <FormControl type="number" className="w-24" bind:value={computerValue} />
        <FormControl as="select" id="tokenSelector" bind:value={selectedTokenName}>
          {#each uniqueInputTokens as token}
            <option value={token}>{token.toUpperCase()}</option>
          {/each}
        </FormControl>
      </div>

      <div>
        <FieldRow columns={rowColumns} header>
          <div>Chain</div>
          <div>Amount / Balance</div>
          <div class="text-center">Use</div>
        </FieldRow>
        <div>
          {#each tokenSet as tkn, rowIndex}
            {@const iaddr = iaddrFor(tkn)}
            <div data-testid={`input-token-row-${getChainName(tkn.chainId)}`}>
              <FieldRow columns={rowColumns} striped index={rowIndex}>
                <div class="truncate text-xs font-medium text-gray-700">
                  {getChainName(tkn.chainId)}
                </div>
                {#await (store.intentType === "compact" ? store.compactBalances : store.balances)[tkn.chainId][tkn.address]}
                  <InlineMetaField
                    bind:value={inputs[iaddr]}
                    metaText="..."
                    disabled={!isEnabled(iaddr)}
                  />
                {:then balance}
                  <InlineMetaField
                    bind:value={inputs[iaddr]}
                    metaText={formatBalance(balance, tkn.decimals)}
                    disabled={!isEnabled(iaddr)}
                  />
                {:catch _}
                  <InlineMetaField
                    bind:value={inputs[iaddr]}
                    metaText="err"
                    disabled={!isEnabled(iaddr)}
                  />
                {/await}
                <div class="flex justify-center">
                  <input type="checkbox" bind:checked={enabledByToken[iaddr]} />
                </div>
              </FieldRow>
            </div>
          {/each}
        </div>
      </div>

      <button
        data-testid="input-token-modal-save"
        class="h-8 w-full cursor-pointer rounded border border-gray-200 bg-white text-sm font-semibold text-gray-700 hover:border-sky-300 hover:text-sky-700"
        onclick={save}>Save Input Selection</button
      >
    </div>
  </div>
</div>
