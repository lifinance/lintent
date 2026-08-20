<script lang="ts">
  import { formatTokenAmount, getChainName, getClient, getCoin } from "$lib/config";
  import { addressToBytes32 } from "@lifi/intent";
  import { encodeMandateOutput } from "@lifi/intent";
  import { hashStruct, keccak256 } from "viem";
  import type { MandateOutput, OrderContainer } from "@lifi/intent";
  import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
  import { Solver } from "$lib/libraries/solver";
  import AwaitButton from "$lib/components/AwaitButton.svelte";
  import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
  import SectionCard from "$lib/components/ui/SectionCard.svelte";
  import ChainActionRow from "$lib/components/ui/ChainActionRow.svelte";
  import TokenAmountChip from "$lib/components/ui/TokenAmountChip.svelte";
  import store from "$lib/state.svelte";
  import { containerToIntent } from "$lib/utils/intent";
  import { compactTypes } from "@lifi/intent";
  import { isSolanaChain, isTronChain } from "$lib/utils/chainType";
  import { isValidTxRef, type TxRef } from "$lib/utils/txRef";
  import { getSolanaReads } from "$lib/solana/client";
  import { readIsLocallyAttested, readIsProvenOnSolana } from "$lib/solana/reads";
  import { getFillDetails } from "$lib/libraries/fillEvent";
  import { getTronReads } from "$lib/tron/client";
  import { readIsProven } from "$lib/tron/reads";

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
  const postHookRefreshValidate = async () => {
    await postHook();
    refreshValidation += 1;
  };
  const outputKey = (output: MandateOutput) =>
    hashStruct({
      data: output,
      types: compactTypes,
      primaryType: "MandateOutput"
    });
  const validationKey = (inputChain: bigint, output: MandateOutput) =>
    `${inputChain.toString()}:${outputKey(output)}`;

  async function isValidated(
    orderId: `0x${string}`,
    chainId: bigint,
    orderContainer: OrderContainer,
    output: MandateOutput,
    // TxRef, not `0x${string}`: this holds a base58 signature whenever the
    // output chain is Solana. Note `chainId` above is the INPUT chain — the
    // two are different chains, and validating against the wrong one silently
    // rejects every Solana fill.
    fillTransactionHash: TxRef,
    _?: any
  ) {
    // Validated against the OUTPUT chain: a Solana fill of an EVM-input order
    // is a base58 signature even though `chainId` here is the input chain.
    if (!isValidTxRef(fillTransactionHash, output.chainId)) return false;
    const { order } = orderContainer;
    // Solver and timestamp come from the OutputFilled event — the recorded
    // solver may be an override, not the transaction sender.
    const { solver, timestamp } = await getFillDetails(orderId, output, fillTransactionHash);
    const encodedOutput = encodeMandateOutput({
      solver,
      orderId,
      timestamp,
      output
    });
    const outputHash = keccak256(encodedOutput);
    if (isSolanaChain(chainId)) {
      // On Solana the oracle CREATES an attestation account, so existence is
      // the proof. A same-chain fill never reaches an oracle at all — the fill
      // itself writes the LocalAttestation.
      const reads = await getSolanaReads(chainId);
      if (output.chainId === chainId) {
        return readIsLocallyAttested(reads, { orderId, output, solver });
      }
      return readIsProvenOnSolana(reads, {
        inputOracle: order.inputOracle,
        output,
        payloadHash: outputHash
      });
    }
    if (isTronChain(chainId)) {
      return await readIsProven(
        await getTronReads(),
        order.inputOracle,
        output.chainId,
        output.oracle,
        output.settler,
        outputHash
      );
    }
    const sourceChainClient = getClient(chainId);
    return await sourceChainClient.readContract({
      address: order.inputOracle,
      abi: POLYMER_ORACLE_ABI,
      functionName: "isProven",
      args: [output.chainId, output.oracle, output.settler, outputHash]
    });
  }

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

    // Each reference is checked against its own output's chain: a Solana fill
    // is base58, an EVM or Tron one a 0x hash.
    if (outputs.some((output, i) => !isValidTxRef(fillTxHashes[i], output.chainId))) return;

    const currentRun = ++validationRun;
    const pairs = inputChains.flatMap((inputChain) =>
      outputs.map((output, outputIndex) => ({
        key: validationKey(inputChain, output),
        run: () =>
          isValidated(
            orderId,
            inputChain,
            orderContainer,
            output,
            fillTxHashes[outputIndex],
            refreshValidation
          )
      }))
    );
    Promise.all(
      pairs.map(async (pair) => {
        try {
          return [pair.key, await pair.run()] as const;
        } catch (e) {
          console.warn(`validation check failed for ${pair.key}`, e);
          return [pair.key, false] as const;
        }
      })
    ).then((entries) => {
      if (currentRun !== validationRun) return;
      const nextStatuses: Record<string, boolean> = {};
      for (const [key, validated] of entries) nextStatuses[key] = validated;
      validationStatuses = nextStatuses;
      if (entries.length === 0 || !entries.every(([, validated]) => validated)) return;
      autoScrolledOrderId = orderId;
      scroll(5)();
    });
  });

  /**
   * Chains this row will actually ask for a signature on, other than the input
   * chain it is labelled with.
   *
   * Proving a Solana output runs `submit` on Solana rather than
   * `receiveMessage` on the input chain (Solver.validate branches on
   * `output.chainId` before it looks at the source chain), so a Base-labelled
   * row can legitimately open a Solana wallet.
   */
  function proofChains(inputChain: bigint | number): bigint[] {
    const elsewhere = orderContainer.order.outputs
      .filter((output) => isSolanaChain(output.chainId) && output.chainId !== BigInt(inputChain))
      .map((output) => output.chainId);
    return [...new Set(elsewhere)];
  }
</script>

<ScreenFrame
  title="Submit Proof of Fill"
  description="Click on each output and wait until they turn green. Polymer does not support batch validation. Continue to the right."
>
  <div class="space-y-2">
    {#each containerToIntent(orderContainer).inputChains() as inputChain}
      <SectionCard compact>
        <ChainActionRow chainLabel={getChainName(inputChain)}>
          {#snippet action()}
            <div class="text-[11px] font-semibold text-gray-500 uppercase">Validate outputs</div>
            <!--
              The row is grouped by INPUT chain, but validating a Solana output
              submits the fill to the Solana oracle — so the signature comes
              from the Solana wallet, not the wallet for the chain named above.
              Said out loud, because an unexplained Solflare prompt on a row
              labelled "Base" reads as a bug.
            -->
            {#each proofChains(inputChain) as proofChain (proofChain)}
              <div class="text-[10px] text-gray-400 normal-case">
                signs on {getChainName(proofChain)}
              </div>
            {/each}
          {/snippet}
          {#snippet chips()}
            {#each orderContainer.order.outputs as output}
              {@const status = validationStatuses[validationKey(inputChain, output)]}
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
                  buttonFunction={status
                    ? async () => {}
                    : Solver.validate(
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
                      )}
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
              {/if}
            {/each}
          {/snippet}
        </ChainActionRow>
      </SectionCard>
    {/each}
  </div>
</ScreenFrame>
