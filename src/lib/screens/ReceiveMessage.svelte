<script lang="ts">
  import { formatTokenAmount, getChainName, getClient, getCoin } from "$lib/config";
  import { encodeMandateOutput } from "@lifi/intent";
  import { hashStruct, keccak256 } from "viem";
  import type { MandateOutput, OrderContainer } from "@lifi/intent";
  import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
  import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
  import { WORMHOLE_ORACLE_ABI } from "$lib/abi/wormholeoracle";
  import { oracleProviderFor } from "$lib/libraries/oracleRoute";
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
  let proofStages = $state<Record<string, string>>({});
  let proofPending = $state<Record<string, boolean>>({});
  let proofBusy = $state<Record<string, boolean>>({});
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
    fillTransactionHash: TxRef
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
    const sameChain = BigInt(output.chainId) === BigInt(chainId);
    const provider = oracleProviderFor(chainId, order.inputOracle);
    if (!sameChain && !provider) throw new Error("Unsupported recorded input oracle.");
    if (isSolanaChain(chainId)) {
      // On Solana the oracle CREATES an attestation account, so existence is
      // the proof. A same-chain fill never reaches an oracle at all — the fill
      // itself writes the LocalAttestation.
      const reads = await getSolanaReads(chainId);
      if (sameChain) {
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
      abi: sameChain
        ? COIN_FILLER_ABI
        : provider === "wormhole"
          ? WORMHOLE_ORACLE_ABI
          : POLYMER_ORACLE_ABI,
      functionName: "isProven",
      args: [output.chainId, output.oracle, output.settler, outputHash]
    });
  }

  async function validateOutput(inputChain: bigint, output: MandateOutput) {
    const key = validationKey(inputChain, output);
    const orderId = containerToIntent(orderContainer).orderId();
    proofBusy[key] = true;
    try {
      const result = await Solver.validate(
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
          account,
          onProgress: (stage: string) => {
            if (containerToIntent(orderContainer).orderId() === orderId) proofStages[key] = stage;
          }
        }
      )();
      if (containerToIntent(orderContainer).orderId() !== orderId) return;
      const pending =
        !!result && typeof result === "object" && "status" in result && result.status === "pending";
      proofPending[key] = pending;
      if (pending) proofStages[key] = "Waiting for Wormhole guardians";
    } catch (error) {
      if (containerToIntent(orderContainer).orderId() === orderId) {
        proofStages[key] = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      if (containerToIntent(orderContainer).orderId() === orderId) proofBusy[key] = false;
    }
  }

  const hasWormholeProof = $derived(
    containerToIntent(orderContainer)
      .inputChains()
      .some(
        (chainId) => oracleProviderFor(chainId, orderContainer.order.inputOracle) === "wormhole"
      )
  );

  const displayedOrderId = $derived(containerToIntent(orderContainer).orderId());
  $effect(() => {
    void displayedOrderId;
    proofStages = {};
    proofPending = {};
    proofBusy = {};
  });

  $effect(() => {
    void refreshValidation;

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
          isValidated(orderId, inputChain, orderContainer, output, fillTxHashes[outputIndex])
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

  /** Wormhole publishes on every remote output; Polymer adds only its Solana submit wallet. */
  function proofChains(inputChain: bigint | number): bigint[] {
    const provider = oracleProviderFor(inputChain, orderContainer.order.inputOracle);
    const elsewhere = orderContainer.order.outputs
      .filter(
        (output) =>
          BigInt(output.chainId) !== BigInt(inputChain) &&
          (provider === "wormhole" || (provider === "polymer" && isSolanaChain(output.chainId)))
      )
      .map((output) => BigInt(output.chainId));
    return [...new Set(elsewhere)];
  }
</script>

<ScreenFrame
  title="Submit Proof of Fill"
  description={hasWormholeProof
    ? "Publish on the destination, wait for Wormhole guardians, then register the VAA on the input chain. Green means the origin proof is confirmed."
    : "Register each fill proof on its input chain. Green means the attestation is confirmed; same-chain fills use the settler."}
>
  <div class="space-y-2">
    {#each containerToIntent(orderContainer).inputChains() as inputChain}
      <SectionCard compact>
        <ChainActionRow chainLabel={getChainName(inputChain)}>
          {#snippet action()}
            <div class="text-[11px] font-semibold text-gray-500 uppercase">Validate outputs</div>
            <!-- Publication and registration can require different connected wallets. -->
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
                    : () => validateOutput(inputChain, output)}
                >
                  {#snippet name()}
                    {#if proofPending[validationKey(inputChain, output)]}
                      Check again
                    {:else}
                      {formatTokenAmount(
                        output.amount,
                        getCoin({ address: output.token, chainId: output.chainId }).decimals
                      )}
                      &nbsp;
                      {getCoin({
                        address: output.token,
                        chainId: output.chainId
                      }).name.toUpperCase()}
                    {/if}
                  {/snippet}
                  {#snippet awaiting()}
                    {proofStages[validationKey(inputChain, output)] ?? "Validating..."}
                  {/snippet}
                </AwaitButton>
                {#if !status && !proofBusy[validationKey(inputChain, output)] && proofStages[validationKey(inputChain, output)]}
                  <span class="text-[10px] text-gray-500">
                    {proofStages[validationKey(inputChain, output)]}
                  </span>
                {/if}
              {/if}
            {/each}
          {/snippet}
        </ChainActionRow>
      </SectionCard>
    {/each}
  </div>
</ScreenFrame>
