import { BYTES32_ZERO, COIN_FILLER, getChain, getClient, getOracle, type WC } from "$lib/config";
import { encodeFunctionData, hashStruct, maxUint256, parseEventLogs } from "viem";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import { addressToBytes32, bytes32ToAddress, StandardSolanaIntent } from "@lifi/intent";
import axios from "axios";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { ERC20_ABI } from "$lib/abi/erc20";
import { containerToIntent } from "$lib/utils/intent";
import { compactTypes } from "@lifi/intent";
import store from "$lib/state.svelte";
import { finaliseIntent } from "./intentExecution";
import { isTronChain } from "$lib/utils/chainType";
import {
  fillTronOutputs,
  claimTronIntent,
  submitTronReceiveMessage,
  getTronTransactionInfo
} from "./tronSolver";
import { getTronBlockTimestamp } from "./tronExecution";

/**
 * @notice Class for solving intents. Functions called by solvers.
 */
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

  private static async getReceiptCachedOrRpc(chainId: number | bigint, txHash: `0x${string}`) {
    const cached = store.getTransactionReceipt(chainId, txHash);
    if (
      cached &&
      typeof cached === "object" &&
      Array.isArray((cached as { logs?: unknown[] }).logs) &&
      (cached as { logs?: unknown[] }).logs!.length > 0
    )
      return cached;
    const receipt = await getClient(chainId).getTransactionReceipt({ hash: txHash });
    await Solver.persistReceipt(chainId, txHash, receipt);
    return receipt;
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

      const outputChainId = Number(outputs[0].chainId);

      if (isTronChain(outputChainId)) {
        const txId = await fillTronOutputs(args.orderContainer, outputs, account());
        if (postHook) await postHook();
        return `0x${txId.replace("0x", "")}` as `0x${string}`;
      }

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
        args: [orderId, outputs, order.fillDeadline, addressToBytes32(account())]
      });
      const fillReceipt = await getClient(outputChain.id).waitForTransactionReceipt({
        hash: transactionHash
      });
      await Solver.persistReceipt(outputs[0].chainId, transactionHash, fillReceipt);
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
      const expectedOutputHash = hashStruct({
        types: compactTypes,
        primaryType: "MandateOutput",
        data: output
      });
      const validationKey = `${Number(sourceChainId)}:${fillTransactionHash}:${expectedOutputHash}`;
      const existingValidation = Solver.validationInflight.get(validationKey);
      if (existingValidation) return existingValidation;

      const validationPromise = (async () => {
        console.log("[validate] start", {
          sourceChainId: Number(sourceChainId),
          outputChainId: Number(output.chainId),
          fillTransactionHash,
          expectedOutputHash,
          inputOracle: order.inputOracle,
          mainnet
        });

        if (
          !fillTransactionHash ||
          !fillTransactionHash.startsWith("0x") ||
          fillTransactionHash.length !== 66
        ) {
          throw new Error(`Invalid fill transaction hash: ${fillTransactionHash}`);
        }

        // Always fetch fresh receipt from RPC — cached receipts may have
        // transaction-local logIndex values instead of block-global ones,
        // which breaks Polymer proof requests.
        console.log("[validate] fetching fresh receipt from output chain", Number(output.chainId));
        const transactionReceipt = await getClient(output.chainId).getTransactionReceipt({
          hash: fillTransactionHash as `0x${string}`
        });
        console.log("[validate] receipt", {
          blockNumber: Number(transactionReceipt.blockNumber),
          logsCount: transactionReceipt.logs.length,
          logIndices: transactionReceipt.logs.map((l) => l.logIndex),
          from: transactionReceipt.from,
          status: transactionReceipt.status
        });

        const logs = parseEventLogs({
          abi: COIN_FILLER_ABI,
          eventName: "OutputFilled",
          logs: transactionReceipt.logs
        });
        console.log(
          "[validate] OutputFilled logs found:",
          logs.length,
          logs.map((l) => ({
            logIndex: l.logIndex,
            outputHash: hashStruct({
              types: compactTypes,
              primaryType: "MandateOutput",
              data: l.args.output
            })
          }))
        );

        // We need to search through each log until we find one matching our output.
        let logIndex = -1;
        for (const log of logs) {
          const logOutput = log.args.output;
          // TODO: Optimise by comparing the dicts.
          const logOutputHash = hashStruct({
            types: compactTypes,
            primaryType: "MandateOutput",
            data: logOutput
          });
          if (logOutputHash === expectedOutputHash) {
            logIndex = log.logIndex;
            break;
          }
        }
        console.log(
          "[validate] matched logIndex:",
          logIndex,
          "expectedOutputHash:",
          expectedOutputHash
        );
        if (logIndex === -1) throw Error(`Could not find matching log`);

        if (order.inputOracle === getOracle("polymer", sourceChainId)) {
          console.log("[validate] using Polymer oracle path");
          let proof: string | undefined;
          const polymerKey = `${Number(output.chainId)}:${Number(transactionReceipt.blockNumber)}:${Number(logIndex)}`;
          let polymerIndex: number | undefined = Solver.polymerRequestIndexByLog.get(polymerKey);
          console.log("[validate] polymer request", {
            polymerKey,
            cachedPolymerIndex: polymerIndex,
            srcChainId: Number(output.chainId),
            srcBlockNumber: Number(transactionReceipt.blockNumber),
            globalLogIndex: Number(logIndex)
          });
          for (const waitMs of [1000, 2000, 4000, 8000]) {
            console.log("[validate] polling polymer proof (next wait:", waitMs, "ms)");
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
            console.log("[validate] polymer response", {
              hasProof: !!dat.proof,
              proofLength: dat.proof?.length,
              polymerIndex: dat.polymerIndex
            });
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
            console.log("[validate] got proof, length:", proof.length);

            if (isTronChain(sourceChainId)) {
              console.log("[validate] submitting receiveMessage to Tron", {
                inputOracle: order.inputOracle,
                proofLength: proof.length
              });
              const txId = await submitTronReceiveMessage(order.inputOracle, proof);
              console.log("[validate] Tron receiveMessage txId:", txId);
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
            console.log("[validate] simulating receiveMessage on chain", Number(sourceChainId), {
              to: order.inputOracle,
              account: account(),
              calldataLength: simCalldata.length
            });
            try {
              await getClient(sourceChainId).call({
                to: order.inputOracle,
                data: simCalldata,
                account: account()
              });
              console.log("[validate] simulation succeeded");
            } catch (simError) {
              console.error("[validate] simulation FAILED", simError);
              throw new Error(
                `receiveMessage simulation failed on chain ${Number(sourceChainId)}: ${Solver.extractRevertReason(simError)}`,
                { cause: simError as Error }
              );
            }

            console.log("[validate] sending receiveMessage tx on chain", Number(sourceChainId));
            const transactionHash = await walletClient.writeContract({
              chain: getChain(sourceChainId),
              account: account(),
              address: order.inputOracle,
              abi: POLYMER_ORACLE_ABI,
              functionName: "receiveMessage",
              args: [proofHex]
            });
            console.log("[validate] receiveMessage tx sent:", transactionHash);

            const result = await getClient(sourceChainId).waitForTransactionReceipt({
              hash: transactionHash,
              timeout: 120_000,
              pollingInterval: 2_000
            });
            console.log("[validate] receiveMessage confirmed, status:", result.status);
            await Solver.persistReceipt(sourceChainId, transactionHash, result);
            if (postHook) await postHook();
            return result;
          }
          console.warn("[validate] polymer proof unavailable after all retries");
          throw new Error(
            `Polymer proof unavailable for output on ${output.chainId.toString()}. Try again after the fill attestation is indexed.`
          );
        } else if (order.inputOracle === COIN_FILLER) {
          console.log("[validate] using COIN_FILLER oracle path");
          const log = logs.find((log) => log.logIndex === logIndex);
          if (!log) throw new Error(`Log with index ${logIndex} not found`);
          console.log("[validate] setAttestation args", {
            orderId: log.args.orderId,
            solver: log.args.solver,
            timestamp: log.args.timestamp,
            output: log.args.output
          });
          if (preHook) await preHook(Number(sourceChainId));
          const transactionHash = await walletClient.writeContract({
            chain: getChain(sourceChainId),
            account: account(),
            address: order.inputOracle,
            abi: COIN_FILLER_ABI,
            functionName: "setAttestation",
            args: [log.args.orderId, log.args.solver, log.args.timestamp, log.args.output]
          });
          console.log("[validate] setAttestation tx sent:", transactionHash);

          const result = await getClient(sourceChainId).waitForTransactionReceipt({
            hash: transactionHash,
            timeout: 120_000,
            pollingInterval: 2_000
          });
          console.log("[validate] setAttestation confirmed, status:", result.status);
          await Solver.persistReceipt(sourceChainId, transactionHash, result);
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
      const fillTimestamps = await Promise.all(
        fillTransactionHashes.map(async (fth, i) => {
          const outputChainId = order.outputs[i].chainId;
          if (isTronChain(outputChainId)) {
            const txInfo = await getTronTransactionInfo(fth.replace("0x", ""));
            return getTronBlockTimestamp(Number(txInfo.blockNumber));
          }
          const receipt = await Solver.getReceiptCachedOrRpc(outputChainId, fth as `0x${string}`);
          // Prefer blockNumber — eth_getBlockByHash is unreliable on many public RPCs.
          // Coerce to bigint in case the cached receipt deserialized blockNumber as a number.
          const blockNumber = receipt.blockNumber != null ? BigInt(receipt.blockNumber) : null;
          const block =
            blockNumber != null
              ? await getClient(outputChainId).getBlock({ blockNumber })
              : await getClient(outputChainId).getBlock({
                  blockHash: receipt.blockHash as `0x${string}`
                });
          return Number(block.timestamp);
        })
      );

      if (isTronChain(sourceChainId)) {
        const txId = await claimTronIntent({
          orderContainer,
          fillTimestamps: fillTimestamps.map(Number),
          account: account()
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

      const solveParams = fillTimestamps.map((fillTimestamp) => {
        return {
          timestamp: Number(fillTimestamp),
          solver: addressToBytes32(account())
        };
      });

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
