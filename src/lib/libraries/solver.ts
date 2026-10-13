import {
  AXELAR_ORACLE,
  BYTES32_ZERO,
  COIN_FILLER,
  getChain,
  getClient,
  getOracle,
  isStellarChain,
  type WC
} from "$lib/config";
import { maxUint256 } from "viem";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import {
  addressToBytes32,
  bytes32ToAddress,
  StandardSolanaIntent,
  StandardStellarIntent
} from "@lifi/intent";
import axios from "axios";
import { AXELAR_ORACLE_ABI } from "$lib/abi/axelaroracle";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { ERC20_ABI } from "$lib/abi/erc20";
import { containerToIntent } from "$lib/utils/intent";
import store from "$lib/state.svelte";
import { finaliseIntent } from "./intentExecution";
import { axelarChainName, axelarGasFee } from "./axelar";
import { findOutputFilledLog, getFillInfo, persistReceipt, solverIdentityFor } from "./fillInfo";
import { getOutputStorageKey } from "./flowProgress";
import { fillStellarOutputs, finaliseStellarIntent, submitStellarAxelar } from "./stellar";

/**
 * @notice Class for solving intents. Functions called by solvers.
 */
export class Solver {
  private static validationInflight = new Map<string, Promise<unknown>>();
  private static polymerRequestIndexByLog = new Map<string, number>();

  private static sleep(ms: number) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
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
    }
  ) {
    return async () => {
      const { preHook, postHook, account } = opts;
      const {
        orderContainer: { order, inputSettler },
        outputs
      } = args;
      const orderId = containerToIntent(args.orderContainer).orderId();

      if (isStellarChain(outputs[0].chainId)) {
        if (outputs.some((output) => output.chainId !== outputs[0].chainId))
          throw new Error("Filling outputs on multiple chains with single fill call not supported");
        const fill = await fillStellarOutputs({
          orderId,
          outputs,
          fillDeadline: order.fillDeadline,
          solver: solverIdentityFor(order),
          source: store.stellarAccount
        });
        await store.saveStellarTransaction(fill.hash, fill);
        if (postHook) await postHook();
        return fill.hash;
      }

      const outputChainId = Number(outputs[0].chainId);
      const outputChain = getChain(outputChainId);
      // Always attempt chain switch before fill, including native-token fills.
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

        // Check allowance & set allowance if needed
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
          await persistReceipt(outputs[0].chainId, approveTransaction, approveReceipt);
        }
      }

      const transactionHash = await walletClient.writeContract({
        chain: outputChain,
        account: account(),
        address: bytes32ToAddress(outputs[0].settler),
        value,
        abi: COIN_FILLER_ABI,
        functionName: "fillOrderOutputs",
        args: [orderId, outputs, order.fillDeadline, solverIdentityFor(order)]
      });
      const fillReceipt = await getClient(outputChain.id).waitForTransactionReceipt({
        hash: transactionHash
      });
      await persistReceipt(outputs[0].chainId, transactionHash, fillReceipt);
      // orderInputs.validate[index] = transactionHash;
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
      const validationKey = `${Number(sourceChainId)}:${fillTransactionHash}:${getOutputStorageKey(output)}`;
      const existingValidation = Solver.validationInflight.get(validationKey);
      if (existingValidation) return existingValidation;

      const validationPromise = (async () => {
        if (!/^0x[0-9a-fA-F]{64}$/.test(fillTransactionHash)) {
          throw new Error(`Invalid fill transaction hash: ${fillTransactionHash}`);
        }
        const fillHash = fillTransactionHash as `0x${string}`;

        if (
          order.inputOracle.toLowerCase() === AXELAR_ORACLE[Number(sourceChainId)]?.toLowerCase()
        ) {
          const orderId = containerToIntent(args.orderContainer).orderId();
          const { payload } = await getFillInfo({
            orderId,
            output,
            fillTransactionHash: fillHash
          });
          // The proof travels from the output chain to the input chain.
          const fee = await axelarGasFee(output.chainId, sourceChainId);
          const destinationChain = axelarChainName(sourceChainId);
          const recipientOracle = addressToBytes32(order.inputOracle);

          if (isStellarChain(output.chainId)) {
            const submit = await submitStellarAxelar({
              destinationChain,
              recipientOracle,
              payloads: [payload],
              gasAmount: fee,
              source: store.stellarAccount
            });
            if (postHook) await postHook();
            return { submitTxHash: submit.hash };
          }

          const outputOracle = AXELAR_ORACLE[Number(output.chainId)];
          if (!outputOracle) throw new Error(`No Axelar oracle on chain ${output.chainId}`);
          if (preHook) await preHook(Number(output.chainId));
          const submitTxHash = await walletClient.writeContract({
            chain: getChain(output.chainId),
            account: account(),
            address: outputOracle,
            abi: AXELAR_ORACLE_ABI,
            functionName: "submit",
            args: [
              destinationChain,
              recipientOracle,
              bytes32ToAddress(output.settler),
              [payload],
              BYTES32_ZERO,
              0 // DeliveryMode.Relayed
            ],
            value: fee
          });
          const result = await getClient(output.chainId).waitForTransactionReceipt({
            hash: submitTxHash,
            timeout: 120_000,
            pollingInterval: 2_000
          });
          await persistReceipt(output.chainId, submitTxHash, result);
          if (postHook) await postHook();
          return { submitTxHash };
        }

        // Get the output filled event.
        const { receipt: transactionReceipt, log: filledLog } = await findOutputFilledLog(
          output,
          fillHash
        );
        const logIndex = filledLog.logIndex;

        if (order.inputOracle === getOracle("polymer", sourceChainId)) {
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
          if (proof) {
            if (preHook) await preHook(Number(sourceChainId));

            const transactionHash = await walletClient.writeContract({
              chain: getChain(sourceChainId),
              account: account(),
              address: order.inputOracle,
              abi: POLYMER_ORACLE_ABI,
              functionName: "receiveMessage",
              args: [`0x${proof.replace("0x", "")}`]
            });

            const result = await getClient(sourceChainId).waitForTransactionReceipt({
              hash: transactionHash,
              timeout: 120_000,
              pollingInterval: 2_000
            });
            await persistReceipt(sourceChainId, transactionHash, result);
            if (postHook) await postHook();
            return result;
          }
          throw new Error(
            `Polymer proof unavailable for output on ${output.chainId.toString()}. Try again after the fill attestation is indexed.`
          );
        } else if (order.inputOracle === COIN_FILLER) {
          const log = filledLog;
          if (preHook) await preHook(Number(sourceChainId));
          const transactionHash = await walletClient.writeContract({
            chain: getChain(sourceChainId),
            account: account(),
            address: order.inputOracle,
            abi: COIN_FILLER_ABI,
            functionName: "setAttestation",
            args: [log.args.orderId, log.args.solver, log.args.timestamp, log.args.output]
          });

          const result = await getClient(sourceChainId).waitForTransactionReceipt({
            hash: transactionHash,
            timeout: 120_000,
            pollingInterval: 2_000
          });
          await persistReceipt(sourceChainId, transactionHash, result);
          if (postHook) await postHook();
          return result;
        }
        throw new Error(
          `Unsupported input oracle ${order.inputOracle} for source chain ${Number(sourceChainId)}.`
        );
      })();

      Solver.validationInflight.set(validationKey, validationPromise);
      try {
        return await validationPromise;
      } finally {
        Solver.validationInflight.delete(validationKey);
      }
    };
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
      const { order } = orderContainer;
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
        if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
          throw new Error(`Invalid fill tx hash at index ${i}: ${hash}`);
        }
      }
      const orderId = intent.orderId();
      const fills = await Promise.all(
        fillTransactionHashes.map((fth, i) =>
          getFillInfo({
            orderId,
            output: order.outputs[i],
            fillTransactionHash: fth as `0x${string}`
          })
        )
      );
      const solver = solverIdentityFor(order);
      const solveParams = fills.map(({ timestamp }) => ({ timestamp, solver }));

      if (intent instanceof StandardStellarIntent) {
        const finalise = await finaliseStellarIntent({
          intent,
          solves: solveParams,
          source: store.stellarAccount
        });
        if (postHook) await postHook();
        return finalise;
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
      await persistReceipt(sourceChainId, transactionHash, result);
      if (postHook) await postHook();
      return result;
    };
  }
}
