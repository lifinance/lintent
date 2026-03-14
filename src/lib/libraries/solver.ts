import {
	BYTES32_ZERO,
	COIN_FILLER,
	getChain,
	getClient,
	getOracle,
	chainMap,
	SOLANA_POLYMER_ORACLE,
	type WC
} from "$lib/config";
import { hashStruct, maxUint256, parseEventLogs } from "viem";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import { addressToBytes32, bytes32ToAddress } from "@lifi/intent";
import axios from "axios";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { ERC20_ABI } from "$lib/abi/erc20";
import { orderToIntent, StandardOrderIntent, MultichainOrderIntent } from "@lifi/intent";
import { compactTypes } from "@lifi/intent";
import store from "$lib/state.svelte";
import { finaliseIntent } from "./intentExecution";
import { SOLANA_POLYMER_SOURCE_CHAIN_ID, isSolanaSubmittedFillRecord } from "./solanaFillLib";

/**
 * @notice Class for solving intents. Functions called by solvers.
 */
export class Solver {
	private static validationInflight = new Map<string, Promise<unknown>>();
	private static polymerRequestIndexByLog = new Map<string, number>();

	private static sleep(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private static async persistReceipt(chainId: number | bigint, txHash: string, receipt: unknown) {
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
			return cached as any;
		const receipt = await getClient(chainId).getTransactionReceipt({ hash: txHash });
		await Solver.persistReceipt(chainId, txHash, receipt);
		return receipt;
	}

	private static getSolanaFillRecord(output: MandateOutput, txRef: string) {
		const record = store.getTransactionReceipt(output.chainId, txRef);
		if (!isSolanaSubmittedFillRecord(record)) {
			throw new Error(`Missing Solana fill metadata for output ${txRef}`);
		}
		return record;
	}

	static fill(
		walletClient: WC,
		args: {
			orderContainer: OrderContainer;
			outputs: MandateOutput[];
			solverBytes32?: `0x${string}`; // override default addressToBytes32(account())
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
				outputs,
				solverBytes32
			} = args;
			const orderId = orderToIntent({ order, inputSettler }).orderId();

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
				args: [orderId, outputs, order.fillDeadline, solverBytes32 ?? addressToBytes32(account())]
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
				if (!fillTransactionHash) {
					throw new Error(`Invalid fill transaction reference: ${fillTransactionHash}`);
				}

				if (output.chainId === BigInt(chainMap.solanaDevnet.id)) {
					const record = Solver.getSolanaFillRecord(output, fillTransactionHash);
					let proof: string | undefined;
					const polymerKey = `${SOLANA_POLYMER_SOURCE_CHAIN_ID}:${record.submitSignature}:${SOLANA_POLYMER_ORACLE}`;
					let polymerIndex: number | undefined = Solver.polymerRequestIndexByLog.get(polymerKey);
					for (const waitMs of [1000, 2000, 4000, 8000, 16000, 32000]) {
						const response = await axios.post(
							`/polymer`,
							{
								srcChainId: SOLANA_POLYMER_SOURCE_CHAIN_ID,
								txSignature: record.submitSignature,
								programID: SOLANA_POLYMER_ORACLE,
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
							`Polymer proof unavailable for Solana output. Request used srcChainId=${SOLANA_POLYMER_SOURCE_CHAIN_ID}, txSignature=${record.submitSignature}, programID=${SOLANA_POLYMER_ORACLE}. Try again after the submit transaction is indexed.`
						);
					}
					if (preHook) await preHook(Number(sourceChainId));
					const transactionHash = await walletClient.writeContract({
						chain: getChain(sourceChainId),
						account: account(),
						address: order.inputOracle,
						abi: POLYMER_ORACLE_ABI,
						functionName: "receiveSolanaMessage",
						args: [`0x${proof.replace("0x", "")}`]
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

				if (!fillTransactionHash.startsWith("0x") || fillTransactionHash.length !== 66) {
					throw new Error(`Invalid fill transaction hash: ${fillTransactionHash}`);
				}

				// Get the output filled event.
				const transactionReceipt = await Solver.getReceiptCachedOrRpc(
					output.chainId,
					fillTransactionHash as `0x${string}`
				);

				const logs = parseEventLogs({
					abi: COIN_FILLER_ABI,
					eventName: "OutputFilled",
					logs: transactionReceipt.logs
				});
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
				if (logIndex === -1) throw Error(`Could not find matching log`);

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
						await Solver.persistReceipt(sourceChainId, transactionHash, result);
						if (postHook) await postHook();
						return result;
					}
					throw new Error(
						`Polymer proof unavailable for output on ${output.chainId.toString()}. Try again after the fill attestation is indexed.`
					);
				} else if (order.inputOracle === COIN_FILLER) {
					const log = logs.find((log) => log.logIndex === logIndex)!;
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
			const intent = orderToIntent({
				inputSettler,
				order
			}) as StandardOrderIntent | MultichainOrderIntent;
			if (fillTransactionHashes.length !== order.outputs.length) {
				throw new Error(
					`Fill transaction hash count (${fillTransactionHashes.length}) does not match output count (${order.outputs.length}).`
				);
			}
			if (preHook) await preHook(Number(sourceChainId));
			const expectedChainId = Number(sourceChainId);
			const connectedChainId = await walletClient.getChainId();
			if (connectedChainId !== expectedChainId) {
				throw new Error(
					`Wallet is on chain ${connectedChainId}, expected ${expectedChainId} before finalise`
				);
			}

			const solveParams = await Promise.all(
				order.outputs.map(async (output, i) => {
					const txRef = fillTransactionHashes[i];
					if (!txRef) {
						throw new Error(`Missing fill transaction reference at index ${i}`);
					}
					if (output.chainId === BigInt(chainMap.solanaDevnet.id)) {
						const record = Solver.getSolanaFillRecord(output, txRef);
						return {
							timestamp: record.fillTimestamp,
							solver: record.solverBytes32
						};
					}
					if (!txRef.startsWith("0x") || txRef.length !== 66) {
						throw new Error(`Invalid fill tx hash at index ${i}: ${txRef}`);
					}
					const transactionReceipt = await Solver.getReceiptCachedOrRpc(
						output.chainId,
						txRef as `0x${string}`
					);
					const logs = parseEventLogs({
						abi: COIN_FILLER_ABI,
						eventName: "OutputFilled",
						logs: transactionReceipt.logs
					});
					const expectedOutputHash = hashStruct({
						types: compactTypes,
						primaryType: "MandateOutput",
						data: output
					});
					const matchingLog = logs.find((log) => {
						const logOutputHash = hashStruct({
							types: compactTypes,
							primaryType: "MandateOutput",
							data: log.args.output
						});
						return logOutputHash === expectedOutputHash;
					});
					if (!matchingLog) {
						throw new Error(`Could not find matching OutputFilled log for output ${i}`);
					}
					const fillTimestamp =
						typeof matchingLog.args.timestamp === "number"
							? matchingLog.args.timestamp
							: Number(matchingLog.args.timestamp);
					return {
						timestamp: fillTimestamp,
						solver: matchingLog.args.solver as `0x${string}`
					};
				})
			);

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
