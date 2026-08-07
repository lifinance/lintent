<script lang="ts">
  import {
    formatTokenAmount,
    getChainName,
    getClient,
    getCoin,
    isHyperlaneOracle
  } from "$lib/config";
  import { getOrderExpiry } from "$lib/libraries/orderExpiry";
  import {
    hyperlaneExplorerUrl,
    hyperlaneSubmissionKey,
    type HyperlaneSubmission
  } from "$lib/libraries/hyperlaneSubmission";
  import { addressToBytes32 } from "@lifi/intent";
  import { hashFillDescription } from "$lib/libraries/fillPayload";
  import { hashStruct } from "viem";
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
  import { isTronChain } from "$lib/utils/chainType";
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

  // --- Hyperlane-specific state ------------------------------------------------------
  // Hyperlane is push based: this screen dispatches the message (paying interchain gas)
  // and then waits on a relayer nobody here controls. Polymer, by contrast, fetches a
  // proof and submits it — so the copy, and the extra diagnostics below, are per rail.
  const isHyperlane = $derived(isHyperlaneOracle(orderContainer.order.inputOracle));

  const description = $derived(
    isHyperlane
      ? "Click each output to dispatch its Hyperlane message from the output chain (this pays " +
          "interchain gas), then wait for a Hyperlane relayer to deliver it. One message per " +
          "output — batch validation is not wired up. Continue to the right."
      : "Click on each output and wait until they turn green. Polymer does not support batch " +
          "validation. Continue to the right."
  );

  // Ticks the countdown below. 1s is cheap and this screen is short-lived.
  let nowMs = $state(Date.now());
  $effect(() => {
    if (!isHyperlane) return;
    const handle = setInterval(() => (nowMs = Date.now()), 1_000);
    return () => clearInterval(handle);
  });

  // Hyperlane delivery can land long after the prove click gave up polling, and nothing
  // else on this screen would notice: re-check the attestation periodically so an output
  // turns green on its own instead of sitting amber forever.
  $effect(() => {
    if (!isHyperlane) return;
    const handle = setInterval(() => (refreshValidation += 1), 20_000);
    return () => clearInterval(handle);
  });
  const expiry = $derived(getOrderExpiry(orderContainer.order.expires, nowMs));

  const orderId = $derived(containerToIntent(orderContainer).orderId());

  const submissionFor = (
    inputChain: bigint,
    output: MandateOutput
  ): HyperlaneSubmission | undefined =>
    store.hyperlaneSubmissions[hyperlaneSubmissionKey(orderId, inputChain, outputKey(output))];

  const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-8)}`;

  async function isValidated(
    orderId: `0x${string}`,
    chainId: bigint,
    orderContainer: OrderContainer,
    output: MandateOutput,
    fillTransactionHash: `0x${string}`,
    _?: any
  ) {
    if (!fillTransactionHash) return false;
    if (
      !fillTransactionHash ||
      !fillTransactionHash.startsWith("0x") ||
      fillTransactionHash.length != 66
    )
      return false;
    const { order } = orderContainer;
    // Solver and timestamp come from the OutputFilled event — the recorded
    // solver may be an override, not the transaction sender.
    const { solver, timestamp } = await getFillDetails(orderId, output, fillTransactionHash);
    // Magic-tagged FillDescription hash — `@lifi/intent@0.2.1`'s encodeMandateOutput
    // omits FILL_MAGIC, so hashing it never matches what the oracle stored.
    const outputHash = hashFillDescription({
      solver,
      orderId,
      timestamp,
      output
    });
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
          isValidated(
            orderId,
            inputChain,
            orderContainer,
            output,
            fillTxHashes[outputIndex] as `0x${string}`,
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
</script>

<ScreenFrame title="Submit Proof of Fill" {description}>
  <div class="space-y-2">
    {#if isHyperlane}
      <!-- Informational only: the relay window is not under our control and the app
           deliberately does not block on expiry. But a solver has already paid the
           output irreversibly, so the deadline is worth real money. -->
      <div
        class={[
          "rounded border px-2 py-1.5 text-[11px] leading-relaxed",
          expiry.expired
            ? "border-red-300 bg-red-50 text-red-800"
            : "border-amber-300 bg-amber-50 text-amber-900"
        ]}
      >
        {#if expiry.expired}
          <div class="font-semibold">Order expiry passed ({expiry.label})</div>
          <div>
            Anyone can now refund the user's inputs on the input chain. If that happens after the
            fill, the solver has paid the output and gets nothing back, and
            <span class="font-mono">finalise</span> reverts. The Hyperlane attestation may still land
            — but it no longer guarantees a claim.
          </div>
        {:else}
          <div class="font-semibold">Order expires in {expiry.label}</div>
          <div>
            The relayer has until then. Hyperlane publishes no delivery SLA, so this wait is not
            under our control; after expiry the inputs become refundable while the output is already
            paid.
          </div>
        {/if}
      </div>
    {/if}
    {#each containerToIntent(orderContainer).inputChains() as inputChain}
      <SectionCard compact>
        <ChainActionRow chainLabel={getChainName(inputChain)}>
          {#snippet action()}
            <div class="text-[11px] font-semibold text-gray-500 uppercase">Validate outputs</div>
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
        {#if isHyperlane}
          <!-- The only place the Hyperlane message id is visible. Without it a stuck
               relay cannot be told apart from a reverted delivery. -->
          {#each orderContainer.order.outputs as output (outputKey(output))}
            {@const submission = submissionFor(inputChain, output)}
            {@const validated = validationStatuses[validationKey(inputChain, output)]}
            <div class="mt-1 border-t border-gray-100 pt-1 text-[10px] leading-relaxed break-all">
              {#if submission}
                <div class="text-gray-600">
                  Dispatched from {getChainName(BigInt(submission.outputChainId))} in
                  <span class="font-mono">{shortHash(submission.submitTxHash)}</span>
                  ({Math.max(0, Math.floor(nowMs / 1000 - submission.submittedAt))}s ago)
                </div>
                {#if submission.messageId}
                  <a
                    class="text-sky-700 underline"
                    href={hyperlaneExplorerUrl(submission.messageId)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Hyperlane message {shortHash(submission.messageId)}
                  </a>
                {:else}
                  <div class="text-gray-500">
                    No message id recorded (no <span class="font-mono">DispatchId</span> event matched)
                    — track the submit transaction instead.
                  </div>
                {/if}
                {#if !validated}
                  <div class="text-gray-500">
                    Waiting for a Hyperlane relayer to deliver <span class="font-mono">handle</span>
                    on {getChainName(inputChain)}. Re-clicking the output above only polls; it does
                    not pay again.
                  </div>
                {/if}
              {:else}
                <div class="text-gray-500">
                  Not dispatched yet — nothing is relaying. Clicking the output above calls
                  <span class="font-mono">submit</span> on the output chain and pays Hyperlane interchain
                  gas.
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </SectionCard>
    {/each}
  </div>
</ScreenFrame>
