<script lang="ts">
  import {
    ALWAYS_OK_ALLOCATOR,
    POLYMER_ALLOCATOR,
    type Token,
    chainList,
    chainMap,
    printToken,
    getClient
  } from "$lib/config";
  import BalanceField from "$lib/components/BalanceField.svelte";
  import AwaitButton from "$lib/components/AwaitButton.svelte";
  import FormControl from "$lib/components/ui/FormControl.svelte";
  import SegmentedControl from "$lib/components/ui/SegmentedControl.svelte";
  import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
  import SectionCard from "$lib/components/ui/SectionCard.svelte";
  import { CompactLib } from "$lib/libraries/compactLib";
  import { toBigIntWithDecimals } from "@lifi/intent";
  import { erc20Abi } from "viem";
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
  const token = $derived<Token>(
    store.availableTokens[selectedTokenIndex] ?? store.availableTokens[0]
  );

  let newTokenAddress = $state<string>("");
  let newTokenChainId = $state<number>(chainMap[chainList(store.mainnet)[0]].id);
  let addTokenError = $state<string>("");

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
  description="Select input type for your intent and manage deposited tokens."
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
              {#each store.availableTokens as tkn, i}
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
    {/if}
    <SectionCard title="Tokens">
      <div class="space-y-2">
        <div class="space-y-1">
          <p class="text-xs font-medium text-gray-600">Add Token</p>
          <FormControl
            type="text"
            id="new-token-address"
            placeholder="0x..."
            bind:value={newTokenAddress}
          />
          <FormControl as="select" id="new-token-chain" bind:value={newTokenChainId}>
            {#each chainList(store.mainnet) as chainName}
              <option value={chainMap[chainName].id}>{chainName}</option>
            {/each}
          </FormControl>
          {#if addTokenError}
            <p class="text-xs text-red-500">{addTokenError}</p>
          {/if}
          <AwaitButton
            buttonFunction={async () => {
              addTokenError = "";
              if (!/^0x[0-9a-fA-F]{40}$/.test(newTokenAddress)) {
                addTokenError = "Invalid address";
                return;
              }
              try {
                const client = getClient(newTokenChainId);
                const addr = newTokenAddress as `0x${string}`;
                const decimals = await client.readContract({
                  address: addr,
                  abi: erc20Abi,
                  functionName: "decimals"
                });
                const symbol = await client.readContract({
                  address: addr,
                  abi: erc20Abi,
                  functionName: "symbol"
                });
                await store.addCustomToken({
                  address: addr,
                  name: symbol.toLowerCase(),
                  chainId: newTokenChainId,
                  decimals: Number(decimals)
                });
                newTokenAddress = "";
              } catch (e) {
                addTokenError = e instanceof Error ? e.message : "Failed to fetch token";
              }
            }}
          >
            {#snippet name()}
              Add
            {/snippet}
            {#snippet awaiting()}
              Fetching...
            {/snippet}
          </AwaitButton>
        </div>
        <div class="space-y-1 border-t border-gray-100 pt-2">
          {#each store.availableTokens as tkn}
            {@const tokenKey = `${tkn.chainId}:${tkn.address.toLowerCase()}`}
            {@const isManual = store.manualTokenKeys.has(tokenKey)}
            <div class="flex items-center justify-between gap-1 text-xs">
              <span class="font-medium">{tkn.name.toUpperCase()}</span>
              <span class="text-gray-500">{printToken(tkn)}</span>
              <span class="truncate font-mono text-gray-400">{tkn.address.slice(0, 8)}…</span>
              {#if isManual}
                <button
                  class="ml-1 cursor-pointer rounded border border-rose-200 bg-rose-50 px-1 text-rose-600 hover:bg-rose-100"
                  onclick={() => store.removeCustomToken(tkn.address, tkn.chainId)}>×</button
                >
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </SectionCard>
  </div>
</ScreenFrame>
