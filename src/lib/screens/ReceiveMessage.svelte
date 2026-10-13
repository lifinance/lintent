<script lang="ts">
  import { AXELAR_ORACLE, formatTokenAmount, getChainName, getCoin } from "$lib/config";
  import type { MandateOutput, OrderContainer } from "@lifi/intent";
  import { Solver } from "$lib/libraries/solver";
  import { axelarscanUrl } from "$lib/libraries/axelar";
  import {
    getOutputStorageKey as outputKey,
    isOutputValidatedOnChain
  } from "$lib/libraries/flowProgress";
  import { invalidateRpcPrefix } from "$lib/libraries/rpcCache";
  import AwaitButton from "$lib/components/AwaitButton.svelte";
  import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
  import SectionCard from "$lib/components/ui/SectionCard.svelte";
  import ChainActionRow from "$lib/components/ui/ChainActionRow.svelte";
  import TokenAmountChip from "$lib/components/ui/TokenAmountChip.svelte";
  import store from "$lib/state.svelte";
  import { containerToIntent } from "$lib/utils/intent";

  // This script needs to be updated to be able to fetch the associated events of fills. Currently, this presents an issue since it can only fill single outputs.

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
  let validationRun = 0;
  let validationStatuses = $state<Record<string, boolean>>({});
  // Axelar submit transactions, keyed like validationStatuses.
  let axelarSubmits = $state<Record<string, `0x${string}`>>({});
  const refreshProofs = () => {
    invalidateRpcPrefix("progress:proven:");
    refreshValidation += 1;
  };
  const postHookRefreshValidate = async () => {
    await postHook();
    refreshProofs();
  };
  const validationKey = (inputChain: bigint, output: MandateOutput) =>
    `${inputChain.toString()}:${outputKey(output)}`;

  const usesAxelar = $derived(
    containerToIntent(orderContainer)
      .inputChains()
      .some(
        (chainId) =>
          AXELAR_ORACLE[Number(chainId)]?.toLowerCase() ===
          orderContainer.order.inputOracle.toLowerCase()
      )
  );

  // Axelar delivers asynchronously (minutes); poll until every proof lands.
  $effect(() => {
    if (!usesAxelar) return;
    const pending = Object.values(validationStatuses).some((validated) => !validated);
    if (!pending) return;
    const handle = setInterval(refreshProofs, 30_000);
    return () => clearInterval(handle);
  });

  const validateOutput = (inputChain: bigint, output: MandateOutput) => {
    const validate = Solver.validate(
      store.walletClient,
      {
        output,
        orderContainer,
        fillTransactionHash: store.fillTransactions[outputKey(output)],
        sourceChainId: Number(inputChain),
        mainnet: store.mainnet
      },
      {
        preHook,
        postHook: postHookRefreshValidate,
        account
      }
    );
    return async () => {
      const result = await validate();
      if (
        result &&
        typeof result === "object" &&
        "submitTxHash" in result &&
        typeof result.submitTxHash === "string"
      )
        axelarSubmits[validationKey(inputChain, output)] = result.submitTxHash as `0x${string}`;
    };
  };

  // const validations = $derived(
  // 	orderContainer.order.outputs.map((output) => {
  // 		return containerToIntent(orderContainer)
  // 			.inputChains()
  // 			.map((inputChain) => {
  // 				return isValidated(
  // 					containerToIntent(orderContainer).orderId(),
  // 					inputChain,
  // 					orderContainer,
  // 					output,
  // 					store.fillTransactions[
  // 						hashStruct({ data: output, types: compactTypes, primaryType: "MandateOutput" })
  // 					],
  // 					refreshValidation
  // 				);
  // 			});
  // 	})
  // );

  $effect(() => {
    refreshValidation;

    const intent = containerToIntent(orderContainer);
    const orderId = intent.orderId();
    if (autoScrolledOrderId === orderId) return;

    const inputChains = intent.inputChains();
    const outputs = orderContainer.order.outputs;
    const fillTxHashes = outputs.map((output) => {
      return store.fillTransactions[outputKey(output)];
    });

    if (
      fillTxHashes.some(
        (fillTxHash) => !fillTxHash || !fillTxHash.startsWith("0x") || fillTxHash.length !== 66
      )
    )
      return;

    const currentRun = ++validationRun;
    const pairs = inputChains.flatMap((inputChain) =>
      outputs.map((output, outputIndex) => ({
        key: validationKey(inputChain, output),
        run: () =>
          isOutputValidatedOnChain(
            orderId,
            inputChain,
            orderContainer,
            output,
            fillTxHashes[outputIndex] as `0x${string}`
          ).catch((error) => {
            console.warn("validation check failed", error);
            return false;
          })
      }))
    );
    Promise.all(pairs.map(async (pair) => [pair.key, await pair.run()] as const))
      .then((entries) => {
        if (currentRun !== validationRun) return;
        const nextStatuses: Record<string, boolean> = {};
        for (const [key, validated] of entries) nextStatuses[key] = validated;
        validationStatuses = nextStatuses;
        if (entries.length === 0 || !entries.every(([, validated]) => validated)) return;
        autoScrolledOrderId = orderId;
        scroll(5)();
      })
      .catch((e) => console.warn("auto-scroll validation check failed", e));
  });
</script>

<ScreenFrame
  title="Submit Proof of Fill"
  description={usesAxelar
    ? "Submit the fill proof through Axelar from the output chain. Delivery takes about 1 minute from Stellar and about 30 minutes to Stellar."
    : "Click on each output and wait until they turn green. Polymer does not support batch validation. Continue to the right."}
>
  <div class="space-y-2">
    {#each containerToIntent(orderContainer).inputChains() as inputChain}
      <SectionCard compact>
        <ChainActionRow chainLabel={getChainName(inputChain)}>
          {#snippet action()}
            <div class="text-[11px] font-semibold text-gray-500 uppercase">Validate outputs</div>
          {/snippet}
          {#snippet chips()}
            {#each orderContainer.order.outputs as output}
              {@const status = validationStatuses[validationKey(inputChain, output)]}
              {@const submitTxHash = axelarSubmits[validationKey(inputChain, output)]}
              {#if status === undefined}
                <TokenAmountChip
                  amountText={formatTokenAmount(
                    output.amount,
                    getCoin({ address: output.token, chainId: output.chainId }).decimals
                  )}
                  symbol={getCoin({ address: output.token, chainId: output.chainId }).name}
                  tone="warning"
                />
              {:else}
                <AwaitButton
                  size="sm"
                  variant={status ? "success" : "warning"}
                  baseClass={["min-w-[6.5rem] justify-center"]}
                  buttonFunction={status ? async () => {} : validateOutput(inputChain, output)}
                >
                  {#snippet name()}
                    {formatTokenAmount(
                      output.amount,
                      getCoin({ address: output.token, chainId: output.chainId }).decimals
                    )}
                    &nbsp;
                    {getCoin({
                      address: output.token,
                      chainId: output.chainId
                    }).name.toUpperCase()}
                  {/snippet}
                  {#snippet awaiting()}
                    Validating...
                  {/snippet}
                </AwaitButton>
                {#if submitTxHash && !status}
                  <a
                    class="text-[11px] font-semibold text-sky-700 underline"
                    href={axelarscanUrl(submitTxHash, output.chainId)}
                    target="_blank"
                    rel="noreferrer">Axelarscan</a
                  >
                {/if}
              {/if}
            {/each}
          {/snippet}
        </ChainActionRow>
      </SectionCard>
    {/each}
  </div>
</ScreenFrame>
