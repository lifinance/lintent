import { BYTES32_ZERO, COIN_FILLER, getChain, getClient, getOracle, type WC } from "$lib/config";
import { encodeFunctionData, hashStruct, keccak256, maxUint256, parseEventLogs } from "viem";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import {
  addressToBytes32,
  bytes32ToAddress,
  StandardSolanaIntent,
  TRON_LEGACY_POLYMER_ORACLES
} from "@lifi/intent";
import axios from "axios";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import { HYPERLANE_ORACLE_ABI } from "$lib/abi/hyperlaneoracle";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { encodeFillDescription } from "./fillPayload";
import { ERC20_ABI } from "$lib/abi/erc20";
import { containerToIntent } from "$lib/utils/intent";
import { compactTypes } from "@lifi/intent";
import store from "$lib/state.svelte";
import { finaliseIntent } from "./intentExecution";
import { getFillDetails } from "./fillEvent";
import {
  findHyperlaneMessageId,
  hyperlaneExplorerUrl,
  hyperlaneSubmissionKey,
  type HyperlaneSubmission
} from "./hyperlaneSubmission";
import { isTronChain } from "$lib/utils/chainType";
import { getTronReads, getTronSigner } from "$lib/tron/client";
import {
  fillOutputs as fillTronOutputs,
  finalise as finaliseTron,
  setAttestation as setTronAttestation,
  submitReceiveMessage as submitTronReceiveMessage
} from "$lib/tron/writes";
import type { TronDeps } from "$lib/tron/types";

async function tronDeps(): Promise<TronDeps> {
  return { reads: await getTronReads(), signer: getTronSigner() };
}

/**
 * @notice Class for solving intents. Functions called by solvers.
 */
/**
 * Destination gas limit for `HyperlaneOracle.handle` on the input chain. `handle`
 * loops over the payloads and writes one cold attestation slot each, so the cost is
 * linear in payload count. Measured (worst case, excluding the 21k intrinsic and the
 * destination Mailbox.process/ISM overhead):
 *
 *   1 payload   55,483        5 payloads  163,947
 *   2 payloads  82,541       10 payloads  299,510
 *
 * i.e. ~28k fixed + ~27k per payload. The formula below is that with ~2.2x headroom
 * for a single payload. Hyperlane's 50,000 default does not even cover one payload,
 * and a short gas limit means the relayer's delivery reverts: the interchain gas is
 * spent and the attestation never lands. Keep it a formula — a multi-output order
 * submits several payloads in one message.
 */
function hyperlaneHandleGasLimit(numPayloads: number): bigint {
  return 80_000n + 40_000n * BigInt(numPayloads);
}

// Hyperlane's `quoteGasPayment` is an `eth_call` snapshot of a gas-price-derived
// quote; the destination gas price can rise between the quote and inclusion, and
// a short payment makes `dispatch` revert. Overpayment is safe here: the oracle
// formats `StandardHookMetadata` with `refundAddress = msg.sender`, so the excess
// comes back to the solver.
const HYPERLANE_QUOTE_BUFFER_PERCENT = 20n;

export class Solver {
  private static validationInflight = new Map<string, Promise<unknown>>();
  private static polymerRequestIndexByLog = new Map<string, number>();

  private static sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private static extractRevertReason(error: unknown): string {
    if (
      error &&
      typeof error === "object" &&
      "cause" in error &&
      error.cause &&
      typeof error.cause === "object" &&
      "data" in error.cause
    ) {
      const reverted = error.cause as { data?: { errorName?: string; args?: unknown[] } };
      if (reverted.data?.errorName) {
        const args = reverted.data.args?.length ? ` (${reverted.data.args.join(", ")})` : "";
        return `${reverted.data.errorName}${args}`;
      }
    }
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private static async persistReceipt(
    chainId: number | bigint,
    txHash: `0x${string}`,
    receipt: unknown
  ) {
    try {
      await store.saveTransactionReceipt(chainId, txHash, receipt);
    } catch (error) {
      console.warn("saveTransactionReceipt error", { chainId: Number(chainId), txHash, error });
    }
  }

  static fill(
    walletClient: WC,
    args: {
      orderContainer: OrderContainer;
      outputs: MandateOutput[];
    },
    opts: {
      preHook?: (chainId: number) => Promise<any>;
      postHook?: () => Promise<any>;
      account: () => `0x${string}`;
      solver?: () => `0x${string}`;
    }
  ) {
    return async () => {
      const { preHook, postHook, account, solver } = opts;
      const solverAddress = solver ? solver() : account();
      const {
        orderContainer: { order },
        outputs
      } = args;
      const orderId = containerToIntent(args.orderContainer).orderId();

      const outputChainId = Number(outputs[0].chainId);

      if (isTronChain(outputChainId)) {
        const txId = await fillTronOutputs(await tronDeps(), {
          orderId,
          outputs,
          fillDeadline: Number(order.fillDeadline),
          solverBytes32: addressToBytes32(solverAddress)
        });
        if (postHook) await postHook();
        return `0x${txId.replace("0x", "")}` as `0x${string}`;
      }

      const outputChain = getChain(outputChainId);
      if (preHook) await preHook(outputChain.id);
      const connectedChainId = await walletClient.getChainId();
      const expectedChainId = outputChain.id;
      if (connectedChainId !== expectedChainId) {
        throw new Error(`Wallet is on chain ${connectedChainId}, expected ${expectedChainId}`);
      }

      let value = 0n;
      for (const output of outputs) {
        if (output.token === BYTES32_ZERO) {
          value += output.amount;
          continue;
        }
        if (output.chainId != outputs[0].chainId) {
          throw new Error("Filling outputs on multiple chains with single fill call not supported");
        }
        if (output.settler != outputs[0].settler) {
          throw new Error("Different settlers on outputs, not supported");
        }

        const assetAddress = bytes32ToAddress(output.token);
        const allowance = await getClient(outputChain.id).readContract({
          address: assetAddress,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [account(), bytes32ToAddress(output.settler)]
        });
        if (BigInt(allowance) < output.amount) {
          const approveTransaction = await walletClient.writeContract({
            chain: outputChain,
            account: account(),
            address: assetAddress,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [bytes32ToAddress(output.settler), maxUint256]
          });
          const approveReceipt = await getClient(outputChain.id).waitForTransactionReceipt({
            hash: approveTransaction
          });
          await Solver.persistReceipt(outputs[0].chainId, approveTransaction, approveReceipt);
        }
      }

      const transactionHash = await walletClient.writeContract({
        chain: outputChain,
        account: account(),
        address: bytes32ToAddress(outputs[0].settler),
        value,
        abi: COIN_FILLER_ABI,
        functionName: "fillOrderOutputs",
        args: [orderId, outputs, order.fillDeadline, addressToBytes32(solverAddress)]
      });
      const fillReceipt = await getClient(outputChain.id).waitForTransactionReceipt({
        hash: transactionHash
      });
      await Solver.persistReceipt(outputs[0].chainId, transactionHash, fillReceipt);
      if (postHook) await postHook();
      return transactionHash;
    };
  }

  static validate(
    walletClient: WC,
    args: {
      output: MandateOutput;
      orderContainer: OrderContainer;
      fillTransactionHash: string;
      sourceChainId: number | bigint;
      mainnet: boolean;
    },
    opts: {
      preHook?: (chainId: number) => Promise<any>;
      postHook?: () => Promise<any>;
      account: () => `0x${string}`;
    }
  ) {
    return async () => {
      const { preHook, postHook, account } = opts;
      const {
        output,
        orderContainer: { order },
        fillTransactionHash,
        sourceChainId,
        mainnet
      } = args;
      const expectedOutputHash = hashStruct({
        types: compactTypes,
        primaryType: "MandateOutput",
        data: output
      });
      const validationKey = `${Number(sourceChainId)}:${fillTransactionHash}:${expectedOutputHash}`;
      const existingValidation = Solver.validationInflight.get(validationKey);
      if (existingValidation) return existingValidation;

      const validationPromise = (async () => {
        if (
          !fillTransactionHash ||
          !fillTransactionHash.startsWith("0x") ||
          fillTransactionHash.length !== 66
        ) {
          throw new Error(`Invalid fill transaction hash: ${fillTransactionHash}`);
        }

        const orderId = containerToIntent(args.orderContainer).orderId();
        const sameChainAttestation =
          order.inputOracle.toLowerCase() === bytes32ToAddress(output.settler).toLowerCase() ||
          order.inputOracle === COIN_FILLER;
        // Accept the current oracle AND known legacy deployments — orders
        // opened before an address rotation must stay provable.
        const polymerOracles = new Set(
          [
            getOracle("polymer", sourceChainId),
            ...(TRON_LEGACY_POLYMER_ORACLES[sourceChainId.toString()] ?? [])
          ]
            .filter((oracle): oracle is `0x${string}` => !!oracle)
            .map((oracle) => oracle.toLowerCase())
        );
        const isPolymerPath =
          !sameChainAttestation && polymerOracles.has(order.inputOracle.toLowerCase());
        const hyperlaneInputOracle = getOracle("hyperlane", sourceChainId);
        const isHyperlanePath =
          !sameChainAttestation &&
          !isPolymerPath &&
          !!hyperlaneInputOracle &&
          hyperlaneInputOracle.toLowerCase() === order.inputOracle.toLowerCase();

        if (sameChainAttestation) {
          // Same-chain fills: the output settler doubles as the oracle, but the
          // fill only writes _fillRecords — proving requires setAttestation with
          // the exact event payload.
          const { solver, timestamp } = await getFillDetails(
            orderId,
            output,
            fillTransactionHash as `0x${string}`
          );

          if (isTronChain(sourceChainId)) {
            const txId = await setTronAttestation(await tronDeps(), {
              outputSettlerBytes32: output.settler,
              orderId,
              solverBytes32: solver,
              timestamp,
              output
            });
            if (postHook) await postHook();
            return { transactionHash: `0x${txId.replace("0x", "")}` };
          }

          if (preHook) await preHook(Number(sourceChainId));
          const transactionHash = await walletClient.writeContract({
            chain: getChain(sourceChainId),
            account: account(),
            address: order.inputOracle,
            abi: COIN_FILLER_ABI,
            functionName: "setAttestation",
            args: [orderId, solver, timestamp, output]
          });
          const result = await getClient(sourceChainId).waitForTransactionReceipt({
            hash: transactionHash,
            timeout: 120_000,
            pollingInterval: 2_000
          });
          await Solver.persistReceipt(sourceChainId, transactionHash, result);
          if (postHook) await postHook();
          return result;
        }

        if (isHyperlanePath) {
          return await Solver.proveHyperlane(walletClient, {
            order,
            orderId,
            output,
            expectedOutputHash,
            fillTransactionHash: fillTransactionHash as `0x${string}`,
            sourceChainId,
            account,
            preHook,
            postHook
          });
        }

        if (!isPolymerPath) {
          throw new Error(
            `Unsupported input oracle ${order.inputOracle} for source chain ${Number(sourceChainId)}.`
          );
        }

        // Cross-chain Polymer path. Always fetch a fresh receipt from RPC —
        // cached receipts may carry transaction-local logIndex values instead
        // of the block-global ones Polymer proof requests need.
        const transactionReceipt = await getClient(output.chainId).getTransactionReceipt({
          hash: fillTransactionHash as `0x${string}`
        });
        if (transactionReceipt.status !== "success") {
          throw new Error(`Fill transaction ${fillTransactionHash} reverted`);
        }

        const logs = parseEventLogs({
          abi: COIN_FILLER_ABI,
          eventName: "OutputFilled",
          logs: transactionReceipt.logs
        });

        // Match with the same strictness as getFillDetails: emitter, indexed
        // orderId, and output struct hash — and never silently pick between
        // ambiguous candidates (the wrong global log index breaks the proof).
        const expectedEmitter = bytes32ToAddress(output.settler).toLowerCase();
        const matches = logs.filter(
          (log) =>
            log.address.toLowerCase() === expectedEmitter &&
            log.args.orderId.toLowerCase() === orderId.toLowerCase() &&
            hashStruct({
              types: compactTypes,
              primaryType: "MandateOutput",
              data: log.args.output
            }) === expectedOutputHash
        );
        if (matches.length === 0) throw Error(`Could not find matching log`);
        if (matches.length > 1) {
          throw new Error(
            `Ambiguous fill: ${matches.length} OutputFilled events match the same order and output`
          );
        }
        const logIndex = matches[0].logIndex;

        let proof: string | undefined;
        const polymerKey = `${Number(output.chainId)}:${Number(transactionReceipt.blockNumber)}:${Number(logIndex)}`;
        let polymerIndex: number | undefined = Solver.polymerRequestIndexByLog.get(polymerKey);
        for (const waitMs of [1000, 2000, 4000, 8000]) {
          const response = await axios.post(
            `/polymer`,
            {
              srcChainId: Number(output.chainId),
              srcBlockNumber: Number(transactionReceipt.blockNumber),
              globalLogIndex: Number(logIndex),
              polymerIndex,
              mainnet: mainnet
            },
            { timeout: 15_000 }
          );
          const dat = response.data as {
            proof: undefined | string;
            polymerIndex: number;
          };
          polymerIndex = dat.polymerIndex;
          if (polymerIndex !== undefined) {
            Solver.polymerRequestIndexByLog.set(polymerKey, polymerIndex);
          }
          if (dat.proof) {
            proof = dat.proof;
            break;
          }
          await Solver.sleep(waitMs);
        }
        if (!proof) {
          throw new Error(
            `Polymer proof unavailable for output on ${output.chainId.toString()}. Try again after the fill attestation is indexed.`
          );
        }

        if (isTronChain(sourceChainId)) {
          const txId = await submitTronReceiveMessage(await tronDeps(), order.inputOracle, proof);
          if (postHook) await postHook();
          return { transactionHash: `0x${txId.replace("0x", "")}` };
        }

        if (preHook) await preHook(Number(sourceChainId));

        const proofHex = `0x${proof.replace("0x", "")}` as `0x${string}`;
        const simCalldata = encodeFunctionData({
          abi: POLYMER_ORACLE_ABI,
          functionName: "receiveMessage",
          args: [proofHex]
        });
        try {
          await getClient(sourceChainId).call({
            to: order.inputOracle,
            data: simCalldata,
            account: account()
          });
        } catch (simError) {
          throw new Error(
            `receiveMessage simulation failed on chain ${Number(sourceChainId)}: ${Solver.extractRevertReason(simError)}`,
            { cause: simError as Error }
          );
        }

        const transactionHash = await walletClient.writeContract({
          chain: getChain(sourceChainId),
          account: account(),
          address: order.inputOracle,
          abi: POLYMER_ORACLE_ABI,
          functionName: "receiveMessage",
          args: [proofHex]
        });

        const result = await getClient(sourceChainId).waitForTransactionReceipt({
          hash: transactionHash,
          timeout: 120_000,
          pollingInterval: 2_000
        });
        await Solver.persistReceipt(sourceChainId, transactionHash, result);
        if (postHook) await postHook();
        return result;
      })();

      Solver.validationInflight.set(validationKey, validationPromise);
      try {
        return await validationPromise;
      } finally {
        Solver.validationInflight.delete(validationKey);
      }
    };
  }

  /**
   * Cross-chain Hyperlane proving.
   *
   * Hyperlane is PUSH based, so unlike Polymer there is no proof to fetch: the
   * solver dispatches the fill payload itself, from the OUTPUT chain, and pays the
   * interchain gas. A Hyperlane relayer then delivers `handle(...)` on the input
   * chain, which writes the attestation `finalise` reads. The wait at the end is
   * for the relayer, not for an indexer.
   *
   * Address layout, which is the inverse of Polymer's:
   *   order.inputOracle = the INPUT chain's HyperlaneOracle  (where `handle` lands)
   *   output.oracle     = the OUTPUT chain's HyperlaneOracle (where `submit` is called)
   */
  /**
   * How long a recorded submit transaction may stay unfindable before the record is
   * discarded. Long enough that a slow-to-index RPC does not trigger a second payment,
   * short enough that a genuinely dropped or replaced transaction does not wedge the
   * flow forever.
   */
  private static readonly HYPERLANE_SUBMIT_MISSING_GRACE_SECONDS = 900;

  /**
   * Checks a persisted submit record against the output chain and returns it only if the
   * dispatch really happened. Reverted records are deleted so a retry pays (correctly);
   * records whose transaction cannot be found are kept for a grace period (an RPC that
   * has not caught up must not cause a second payment) and then dropped.
   */
  private static async reconcileHyperlaneSubmission(
    submission: HyperlaneSubmission,
    ctx: {
      outputClient: ReturnType<typeof getClient>;
      outputOracle: `0x${string}`;
      destinationDomain: number;
      inputOracle: `0x${string}`;
    }
  ): Promise<HyperlaneSubmission | undefined> {
    let receipt;
    try {
      receipt = await ctx.outputClient.getTransactionReceipt({ hash: submission.submitTxHash });
    } catch {
      const ageSeconds = Math.floor(Date.now() / 1000) - submission.submittedAt;
      if (ageSeconds <= Solver.HYPERLANE_SUBMIT_MISSING_GRACE_SECONDS) {
        throw new Error(
          `Hyperlane submit ${submission.submitTxHash} was recorded ${ageSeconds}s ago but no ` +
            `receipt is available yet on chain ${submission.outputChainId}. Interchain gas may ` +
            `already be paid, so this step will not pay again — wait and retry.`
        );
      }
      console.warn("Discarding Hyperlane submit record with no findable receipt", {
        key: submission.key,
        submitTxHash: submission.submitTxHash,
        ageSeconds
      });
      await store.deleteHyperlaneSubmission(submission.key);
      return undefined;
    }

    if (receipt.status !== "success") {
      // Nothing was dispatched, so the record must not keep claiming a relay.
      await store.deleteHyperlaneSubmission(submission.key);
      return undefined;
    }

    if (submission.messageId) return submission;
    // The record may have been written before the receipt was available (e.g. a reload
    // right after the submit), in which case the message id is still missing.
    const messageId = findHyperlaneMessageId(receipt.logs, {
      sender: ctx.outputOracle,
      destinationDomain: ctx.destinationDomain,
      recipient: ctx.inputOracle
    });
    if (!messageId) return submission;
    const updated = { ...submission, messageId };
    await store.saveHyperlaneSubmission(updated);
    return updated;
  }

  private static async proveHyperlane(
    walletClient: WC,
    args: {
      order: { inputOracle: `0x${string}` };
      orderId: `0x${string}`;
      output: MandateOutput;
      expectedOutputHash: `0x${string}`;
      fillTransactionHash: `0x${string}`;
      sourceChainId: number | bigint;
      account: () => `0x${string}`;
      preHook?: (chainId: number) => Promise<unknown>;
      postHook?: () => Promise<unknown>;
    }
  ) {
    const {
      order,
      orderId,
      output,
      expectedOutputHash,
      fillTransactionHash,
      sourceChainId,
      account,
      preHook,
      postHook
    } = args;

    if (isTronChain(sourceChainId) || isTronChain(output.chainId)) {
      throw new Error("Hyperlane proving is only wired for EVM chains.");
    }

    const outputChainId = Number(output.chainId);
    const inputChainId = Number(sourceChainId);
    const outputClient = getClient(outputChainId);
    const inputClient = getClient(inputChainId);

    // `output.oracle` must be the OUTPUT chain's oracle for Hyperlane — this is
    // where `submit` is called and, on the input chain, the message sender the
    // attestation is keyed by. Reject anything else loudly rather than paying
    // interchain gas for a message that can never be matched.
    const outputOracle = bytes32ToAddress(output.oracle);
    const expectedOutputOracle = getOracle("hyperlane", outputChainId);
    if (!expectedOutputOracle) {
      throw new Error(`No Hyperlane oracle configured for output chain ${outputChainId}.`);
    }
    if (outputOracle.toLowerCase() !== expectedOutputOracle.toLowerCase()) {
      throw new Error(
        `output.oracle ${outputOracle} is not the Hyperlane oracle on chain ${outputChainId} ` +
          `(${expectedOutputOracle}). Hyperlane orders must point output.oracle at the OUTPUT chain.`
      );
    }

    // Fresh receipt from RPC: a cached receipt may carry transaction-local log
    // indices and, more importantly, must not be trusted for solver/timestamp.
    const transactionReceipt = await outputClient.getTransactionReceipt({
      hash: fillTransactionHash
    });
    if (transactionReceipt.status !== "success") {
      throw new Error(`Fill transaction ${fillTransactionHash} reverted`);
    }

    const logs = parseEventLogs({
      abi: COIN_FILLER_ABI,
      eventName: "OutputFilled",
      logs: transactionReceipt.logs
    });
    // Same strictness as getFillDetails: emitter, indexed orderId and output
    // struct hash — and never silently pick between ambiguous candidates.
    const expectedEmitter = bytes32ToAddress(output.settler).toLowerCase();
    const matches = logs.filter(
      (log) =>
        log.address.toLowerCase() === expectedEmitter &&
        log.args.orderId.toLowerCase() === orderId.toLowerCase() &&
        hashStruct({
          types: compactTypes,
          primaryType: "MandateOutput",
          data: log.args.output
        }) === expectedOutputHash
    );
    if (matches.length === 0) throw new Error(`Could not find matching log`);
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous fill: ${matches.length} OutputFilled events match the same order and output`
      );
    }

    // Solver and timestamp come from the event, never from receipt.from or a local
    // clock: the recorded solver may be an override and the timestamp is the exact
    // uint32 hashed into the attested payload.
    const solver = matches[0].args.solver as `0x${string}`;
    const timestamp = Number(matches[0].args.timestamp);

    const payload = encodeFillDescription({ solver, orderId, timestamp, output });
    const payloadHash = keccak256(payload);

    const isProven = () =>
      inputClient.readContract({
        address: order.inputOracle,
        abi: HYPERLANE_ORACLE_ABI,
        functionName: "isProven",
        args: [output.chainId, output.oracle, output.settler, payloadHash]
      });

    // The relayer may already have delivered (e.g. after a page reload), and a
    // second submit would pay interchain gas for nothing.
    if (await isProven()) {
      if (postHook) await postHook();
      return { transactionHash: undefined, alreadyProven: true } as const;
    }

    // Duplicate-payment protection has to survive a page reload: reloading is exactly
    // what a user does when a step looks stuck, and a second `submit` dispatches a
    // second message and pays interchain gas again. The record is therefore persisted
    // (see `store.hyperlaneSubmissions`) rather than kept in a process-local map.
    const submitKey = hyperlaneSubmissionKey(orderId, inputChainId, expectedOutputHash);
    const existingSubmission = store.hyperlaneSubmissions[submitKey];
    // A record for a *different* payload (a re-fill with another solver or timestamp)
    // attests to nothing about this one — ignore it rather than suppressing a needed
    // dispatch.
    const reusableSubmission =
      existingSubmission?.payloadHash.toLowerCase() === payloadHash.toLowerCase()
        ? existingSubmission
        : undefined;
    const source = bytes32ToAddress(output.settler);
    // Hyperlane's `domain` equals the EVM chain id on the chains configured here.
    const destinationDomain = inputChainId;
    // One payload per validated output today; the gas limit scales with the array
    // so batching more outputs into a single message stays correct.
    const payloads = [payload];
    const submitArgs = [
      destinationDomain,
      order.inputOracle,
      hyperlaneHandleGasLimit(payloads.length),
      "0x",
      source,
      payloads
    ] as const;

    // A record is written as soon as the transaction is broadcast (the gas is committed
    // at that point), so a reused record may describe a transaction that later reverted,
    // was dropped or was replaced — the page that would have cleaned it up may have been
    // reloaded. Reconcile it against the chain before trusting it, or the record would
    // suppress a needed re-dispatch forever and the UI would claim a message is relaying
    // that never existed.
    let submitTransactionHash: `0x${string}` | undefined;
    let messageId: `0x${string}` | undefined;
    if (reusableSubmission) {
      const reconciled = await Solver.reconcileHyperlaneSubmission(reusableSubmission, {
        outputClient,
        outputOracle,
        destinationDomain,
        inputOracle: order.inputOracle
      });
      submitTransactionHash = reconciled?.submitTxHash;
      messageId = reconciled?.messageId;
    }
    if (!submitTransactionHash) {
      const quote = await outputClient.readContract({
        address: outputOracle,
        abi: HYPERLANE_ORACLE_ABI,
        functionName: "quoteGasPayment",
        args: submitArgs,
        account: account()
      });
      const value = quote + (quote * HYPERLANE_QUOTE_BUFFER_PERCENT) / 100n;

      const simCalldata = encodeFunctionData({
        abi: HYPERLANE_ORACLE_ABI,
        functionName: "submit",
        args: submitArgs
      });
      try {
        await outputClient.call({
          to: outputOracle,
          data: simCalldata,
          value,
          account: account()
        });
      } catch (simError) {
        throw new Error(
          `Hyperlane submit simulation failed on chain ${outputChainId}: ${Solver.extractRevertReason(simError)}`,
          { cause: simError as Error }
        );
      }

      // `submit` happens on the OUTPUT chain, not the input chain.
      if (preHook) await preHook(outputChainId);
      const connectedChainId = await walletClient.getChainId();
      if (connectedChainId !== outputChainId) {
        throw new Error(
          `Wallet is on chain ${connectedChainId}, expected ${outputChainId} before Hyperlane submit`
        );
      }

      submitTransactionHash = await walletClient.writeContract({
        chain: getChain(outputChainId),
        account: account(),
        address: outputOracle,
        abi: HYPERLANE_ORACLE_ABI,
        functionName: "submit",
        args: submitArgs,
        value
      });
      // Persist BEFORE awaiting the receipt: the gas is already committed at this
      // point, and a reload during the wait must not lose that.
      const submission: HyperlaneSubmission = {
        key: submitKey,
        orderId,
        inputChainId,
        outputChainId,
        outputHash: expectedOutputHash,
        payloadHash,
        submitTxHash: submitTransactionHash,
        submittedAt: Math.floor(Date.now() / 1000)
      };
      await store.saveHyperlaneSubmission(submission);

      const submitReceipt = await outputClient.waitForTransactionReceipt({
        hash: submitTransactionHash,
        timeout: 120_000,
        pollingInterval: 2_000
      });
      await Solver.persistReceipt(outputChainId, submitTransactionHash, submitReceipt);
      if (submitReceipt.status !== "success") {
        // Nothing was dispatched, so a retry should pay again — and the UI must stop
        // claiming the order is relaying.
        await store.deleteHyperlaneSubmission(submitKey);
        throw new Error(`Hyperlane submit transaction ${submitTransactionHash} reverted`);
      }

      // The oracle discards the message id `dispatch` returns, so the Mailbox
      // `DispatchId` event is the only place to read it — and it is what makes a stuck
      // relay diagnosable on the Hyperlane explorer.
      messageId = findHyperlaneMessageId(submitReceipt.logs, {
        sender: outputOracle,
        destinationDomain,
        recipient: order.inputOracle
      });
      if (messageId) {
        await store.saveHyperlaneSubmission({ ...submission, messageId });
      } else {
        console.warn("Hyperlane DispatchId event not found in submit receipt", {
          submitTransactionHash,
          outputChainId
        });
      }
    }

    if (postHook) await postHook();

    // Wait for the relayer to deliver `handle` on the input chain. Nothing local
    // can hurry this along; `finalise` cannot succeed until the attestation lands.
    for (const waitMs of [5_000, 5_000, 10_000, 10_000, 15_000, 15_000, 30_000, 30_000, 30_000]) {
      await Solver.sleep(waitMs);
      if (await isProven()) {
        if (postHook) await postHook();
        return { transactionHash: submitTransactionHash, messageId, alreadyProven: false } as const;
      }
    }

    throw new Error(
      `Hyperlane message dispatched (tx ${submitTransactionHash}` +
        (messageId ? `, message ${messageId} — ${hyperlaneExplorerUrl(messageId)}` : "") +
        `) but the relayer has not delivered it to chain ${inputChainId} yet. Nothing is lost — ` +
        `retry this step and it will only poll (the dispatch is recorded and survives a reload), ` +
        `and the progress tracker will turn green on its own once the attestation lands.`
    );
  }

  static claim(
    walletClient: WC,
    args: {
      orderContainer: OrderContainer;
      fillTransactionHashes: string[];
      sourceChainId: number | bigint;
    },
    opts: {
      preHook?: (chainId: number) => Promise<any>;
      postHook?: () => Promise<any>;
      account: () => `0x${string}`;
    }
  ) {
    return async () => {
      const { preHook, postHook, account } = opts;
      const { orderContainer, fillTransactionHashes, sourceChainId } = args;
      const { order, inputSettler } = orderContainer;
      const intent = containerToIntent(orderContainer);
      if (intent instanceof StandardSolanaIntent)
        throw new Error("Finalise is not supported for Solana input intents.");

      if (fillTransactionHashes.length !== order.outputs.length) {
        throw new Error(
          `Fill transaction hash count (${fillTransactionHashes.length}) does not match output count (${order.outputs.length}).`
        );
      }
      for (let i = 0; i < fillTransactionHashes.length; i++) {
        const hash = fillTransactionHashes[i];
        if (!hash || !hash.startsWith("0x") || hash.length !== 66) {
          throw new Error(`Invalid fill tx hash at index ${i}: ${hash}`);
        }
      }

      // Solve parameters come from the OutputFilled events: the recorded
      // solver is whatever fillerData proposed (which may be an override, not
      // the filling wallet), and the recorded timestamp is the exact value
      // hashed on-chain — deriving either from local context breaks finalise.
      const orderId = intent.orderId();
      const solveParams = await Promise.all(
        fillTransactionHashes.map(async (fth, i) => {
          const output = order.outputs[i];
          const { solver, timestamp } = await getFillDetails(orderId, output, fth as `0x${string}`);
          return { timestamp, solver };
        })
      );

      // The input settler derives the order owner from solveParams[0].solver
      // and requires msg.sender to be that owner.
      const owner = bytes32ToAddress(solveParams[0].solver);
      if (owner.toLowerCase() !== account().toLowerCase()) {
        throw new Error(
          `This order was filled for solver ${owner} — connect that wallet to claim (connected: ${account()}).`
        );
      }

      if (isTronChain(sourceChainId)) {
        if (!("originChainId" in order)) {
          throw new Error("Tron claim only supports single-chain (StandardOrder) intents");
        }
        const txId = await finaliseTron(await tronDeps(), {
          inputSettler,
          order,
          solveParams,
          destinationBytes32: addressToBytes32(account())
        });
        if (postHook) await postHook();
        return `0x${txId.replace("0x", "")}`;
      }

      if (preHook) await preHook(Number(sourceChainId));
      const expectedChainId = Number(sourceChainId);
      const connectedChainId = await walletClient.getChainId();
      if (connectedChainId !== expectedChainId) {
        throw new Error(
          `Wallet is on chain ${connectedChainId}, expected ${expectedChainId} before finalise`
        );
      }

      const transactionHash = await finaliseIntent({
        intent,
        sourceChainId,
        account: account(),
        walletClient,
        solveParams,
        signatures: orderContainer
      });
      if (!transactionHash) {
        throw new Error(
          `Finalise did not return a transaction hash for source chain ${Number(sourceChainId)}.`
        );
      }
      let result;
      try {
        result = await getClient(sourceChainId).waitForTransactionReceipt({
          hash: transactionHash,
          timeout: 120_000,
          pollingInterval: 2_000
        });
      } catch (error) {
        throw new Error(
          `Timed out waiting for finalise tx receipt on ${Number(sourceChainId)} for hash ${transactionHash}.`,
          { cause: error as Error }
        );
      }
      await Solver.persistReceipt(sourceChainId, transactionHash, result);
      if (postHook) await postHook();
      return result;
    };
  }
}
