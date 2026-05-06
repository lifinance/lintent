<script lang="ts">
  import { BYTES32_ZERO, formatTokenAmount, getChainName, getClient, getCoin } from "$lib/config";
  import { bytes32ToAddress } from "@lifi/intent";
  import { getOutputHash } from "@lifi/intent";
  import type { MandateOutput, OrderContainer } from "@lifi/intent";
  import { Solver } from "$lib/libraries/solver";
  import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
  import AwaitButton from "$lib/components/AwaitButton.svelte";
  import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
  import SectionCard from "$lib/components/ui/SectionCard.svelte";
  import ChainActionRow from "$lib/components/ui/ChainActionRow.svelte";
  import TokenAmountChip from "$lib/components/ui/TokenAmountChip.svelte";
  import store from "$lib/state.svelte";
  import { orderToIntent } from "@lifi/intent";
  import { compactTypes } from "@lifi/intent";
  import { hashStruct } from "viem";

  let {
    scroll,
    orderContainer,
    account,
    preHook,
    postHook
  }: {
    scroll: (direction: boolean | number) => () => void;
    orderContainer: OrderContainer;
    preHook?: (chainId: number) => Promise<any>;
    postHook: () => Promise<any>;
    account: () => `0x${string}`;
  } = $props();

  let refreshValidation = $state(0);
  let autoScrolledOrderId = $state<`0x${string}` | null>(null);
  let fillRun = 0;
  let fillStatuses = $state<Record<string, `0x${string}`>>({});
  let manualFillTxInputs = $state<Record<string, string>>({});
  let manualFillTxSaving = $state<Record<string, boolean>>({});
  let manualFillTxSaved = $state<Record<string, boolean>>({});
  let manualFillTxErrors = $state<Record<string, string>>({});
  const postHookScroll = async () => {
    await postHook();
    refreshValidation += 1;
  };

  async function isFilled(orderId: `0x${string}`, output: MandateOutput, _?: any) {
    const outputHash = getOutputHash(output);
    const outputClient = getClient(output.chainId);
    const result = await outputClient.readContract({
      address: bytes32ToAddress(output.settler),
      abi: COIN_FILLER_ABI,
      functionName: "getFillRecord",
      args: [orderId, outputHash]
    });
    return result;
  }

  function sortOutputsByChain(orderContainer: OrderContainer) {
    const outputs = orderContainer.order.outputs;
    const positionMap: { [chainId: string]: number } = {};
    const arrMap: [bigint, MandateOutput[]][] = [];
    for (const output of outputs) {
      const chainId = output.chainId;
      // Check if chainId exists.
      let position = positionMap[chainId.toString()];
      if (position == undefined) {
        position = arrMap.length;
        positionMap[chainId.toString()] = position;
        arrMap.push([chainId, []]);
      }
      arrMap[position][1].push(output);
    }
    return arrMap;
  }
  const outputKey = (output: MandateOutput) =>
    hashStruct({
      data: output,
      types: compactTypes,
      primaryType: "MandateOutput"
    });
  const isValidFillTxHash = (value: string): value is `0x${string}` =>
    value.startsWith("0x") && value.length === 66;
  const getManualFillTxInputValue = (output: MandateOutput) => {
    const key = outputKey(output);
    return manualFillTxInputs[key] ?? store.fillTransactions[key] ?? "";
  };
  const saveManualFillTransaction = async (output: MandateOutput) => {
    const key = outputKey(output);
    const txHash = getManualFillTxInputValue(output).trim();
    if (!isValidFillTxHash(txHash)) {
      manualFillTxErrors[key] = "Use a 0x-prefixed 66-char tx hash.";
      manualFillTxSaved[key] = false;
      return;
    }
    manualFillTxSaving[key] = true;
    manualFillTxErrors[key] = "";
    try {
      store.fillTransactions[key] = txHash;
      await store.saveFillTransaction(key, txHash);
      manualFillTxSaved[key] = true;
      refreshValidation += 1;
    } catch (error) {
      console.warn("saveFillTransaction error", error);
      manualFillTxErrors[key] = "Failed to save tx hash.";
      manualFillTxSaved[key] = false;
    } finally {
      manualFillTxSaving[key] = false;
    }
  };

  $effect(() => {
    refreshValidation;

    const orderId = orderToIntent(orderContainer).orderId();
    if (autoScrolledOrderId === orderId) return;

    const outputs = sortOutputsByChain(orderContainer).flatMap(([, chainOutputs]) => chainOutputs);
    if (outputs.length === 0) return;

    const currentRun = ++fillRun;
    Promise.all(
      outputs.map(async (output) => [outputKey(output), await isFilled(orderId, output)] as const)
    )
      .then((entries) => {
        if (currentRun !== fillRun) return;
        const nextStatuses: Record<string, `0x${string}`> = {};
        for (const [key, status] of entries) nextStatuses[key] = status;
        fillStatuses = nextStatuses;
        if (!entries.every(([, result]) => result !== BYTES32_ZERO)) return;
        autoScrolledOrderId = orderId;
        scroll(4)();
      })
      .catch((e) => console.warn("auto-scroll fill check failed", e));
  });

  const fillWrapper = (outputs: MandateOutput[], func: ReturnType<typeof Solver.fill>) => {
    return async () => {
      const result = await func();

      for (const output of outputs) {
        const outputHash = hashStruct({
          data: output,
          types: compactTypes,
          primaryType: "MandateOutput"
        });
        store.fillTransactions[outputHash] = result;
        store
          .saveFillTransaction(outputHash, result)
          .catch((e) => console.warn("saveFillTransaction error", e));
      }
    };
  };
</script>

<ScreenFrame
  title="Fill Intent"
  description="Fill each chain once and continue to the right. If you refreshed the page provide your fill tx hash in the input box."
>
  <div class="space-y-2">
    <SectionCard compact title="Add Fill Tx Hash">
      <div class="space-y-2">
        {#each orderContainer.order.outputs as output}
          {@const key = outputKey(output)}
          {@const currentHash = store.fillTransactions[key]}
          <div class="flex flex-wrap items-center gap-2">
            <TokenAmountChip
              amountText={formatTokenAmount(
                output.amount,
                getCoin({ address: output.token, chainId: output.chainId }).decimals
              )}
              symbol={getCoin({ address: output.token, chainId: output.chainId }).name}
              tone={isValidFillTxHash(currentHash ?? "") ? "success" : "warning"}
            />
            <input
              type="text"
              class="h-7 min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 text-xs text-gray-700 outline-none focus:border-sky-300"
              placeholder="0x... fill tx hash"
              value={getManualFillTxInputValue(output)}
              oninput={(event) => {
                const value = (event.currentTarget as HTMLInputElement).value;
                manualFillTxInputs[key] = value;
                manualFillTxSaved[key] = false;
                manualFillTxErrors[key] = "";
              }}
            />
            <button
              type="button"
              class="h-7 rounded border border-gray-200 bg-white px-2 text-xs font-semibold text-gray-700 hover:border-sky-300 hover:text-sky-700 disabled:cursor-not-allowed disabled:text-gray-400"
              disabled={manualFillTxSaving[key]}
              onclick={() => saveManualFillTransaction(output)}
            >
              {manualFillTxSaving[key] ? "Saving..." : "Save Tx"}
            </button>
            {#if manualFillTxErrors[key]}
              <div class="text-[11px] font-semibold text-rose-600">{manualFillTxErrors[key]}</div>
            {:else if manualFillTxSaved[key]}
              <div class="text-[11px] font-semibold text-emerald-700">Saved</div>
            {/if}
          </div>
        {/each}
      </div>
    </SectionCard>
    {#each sortOutputsByChain(orderContainer) as chainIdAndOutputs}
      <SectionCard compact>
        <ChainActionRow chainLabel={getChainName(chainIdAndOutputs[0])}>
          {#snippet action()}
            {@const chainStatuses = chainIdAndOutputs[1].map(
              (output) => fillStatuses[outputKey(output)]
            )}
            {#if chainStatuses.some((status) => status === undefined)}
              <button
                type="button"
                class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
                disabled
              >
                Fill
              </button>
            {:else}
              <AwaitButton
                variant={chainStatuses.every((v) => v == BYTES32_ZERO) ? "default" : "muted"}
                buttonFunction={chainStatuses.every((v) => v == BYTES32_ZERO)
                  ? fillWrapper(
                      chainIdAndOutputs[1],
                      Solver.fill(
                        store.walletClient,
                        {
                          orderContainer,
                          outputs: chainIdAndOutputs[1]
                        },
                        {
                          preHook,
                          postHook: postHookScroll,
                          account
                        }
                      )
                    )
                  : async () => {}}
              >
                {#snippet name()}
                  Fill
                {/snippet}
                {#snippet awaiting()}
                  Waiting for transaction...
                {/snippet}
              </AwaitButton>
            {/if}
          {/snippet}
          {#snippet chips()}
            {#each chainIdAndOutputs[1] as output}
              {@const filled = fillStatuses[outputKey(output)]}
              <TokenAmountChip
                amountText={formatTokenAmount(
                  output.amount,
                  getCoin({
                    address: output.token,
                    chainId: output.chainId
                  }).decimals
                )}
                symbol={getCoin({ address: output.token, chainId: output.chainId }).name}
                tone={filled === undefined
                  ? "muted"
                  : filled === BYTES32_ZERO
                    ? "neutral"
                    : "success"}
              />
            {/each}
          {/snippet}
        </ChainActionRow>
      </SectionCard>
    {/each}
  </div>
</ScreenFrame>
