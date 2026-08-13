import { BYTES32_ZERO, COIN_FILLER, getChain, getClient, getOracle, type WC } from "$lib/config";
import { encodeFunctionData, hashStruct, maxUint256, parseEventLogs } from "viem";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import {
  addressToBytes32,
  bytes32ToAddress,
  bytes32ToSolanaBase58,
  StandardSolanaIntent,
  TRON_LEGACY_POLYMER_ORACLES
} from "@lifi/intent";
import axios from "axios";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { ERC20_ABI } from "$lib/abi/erc20";
import { containerToIntent } from "$lib/utils/intent";
import { compactTypes } from "@lifi/intent";
import store from "$lib/state.svelte";
import { finaliseIntent } from "./intentExecution";
import { getFillDetails } from "./fillEvent";
import { isSolanaChain, isTronChain } from "$lib/utils/chainType";
import { isValidTxRef } from "$lib/utils/txRef";
import { getSolanaReads } from "$lib/solana/client";
import { createSolanaPrograms } from "$lib/solana/program";
import { getSolanaSigner } from "$lib/solana/wallet";
import {
  fillOutputs as fillSolanaOutputs,
  finalise as finaliseSolana,
  submitFillProof as submitSolanaFillProof
} from "$lib/solana/writes";
import type { SolanaDeps } from "$lib/solana/types";
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
 * Assembles the Solana dependency bundle for a chain.
 *
 * The chain id is always taken from the order — never from the UI's network
 * toggle — so a devnet order cannot be signed against mainnet.
 */
async function solanaDeps(chainId: bigint): Promise<SolanaDeps> {
  const signer = await getSolanaSigner(chainId);
  const [reads, programs] = await Promise.all([
    getSolanaReads(chainId),
    createSolanaPrograms({ chainId, publicKey: signer.publicKey })
  ]);
  return { chainId, reads, signer, programs };
}

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

      if (isSolanaChain(outputChainId)) {
        // One instruction per output, but ONE transaction: the caller stores a
        // single reference for the whole group, and each output's solver and
        // timestamp are later recovered from that transaction's logs. Separate
        // transactions would leave outputs 2..N filled but unprovable.
        const signature = await fillSolanaOutputs(await solanaDeps(BigInt(outputChainId)), {
          orderId,
          outputs,
          fillDeadline: Number(order.fillDeadline),
          solverBytes32: addressToBytes32(solverAddress)
        });
        if (postHook) await postHook();
        return signature;
      }

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
        // Validated against the OUTPUT chain: a Solana fill is a base58
        // signature even when the order's source chain is EVM.
        if (!isValidTxRef(fillTransactionHash, output.chainId)) {
          throw new Error(`Invalid fill transaction hash: ${fillTransactionHash}`);
        }

        const orderId = containerToIntent(args.orderContainer).orderId();

        // A Solana OUTPUT is proven by submitting the fill to Polymer, which
        // reads the `Prove:` log the submit instruction writes. A same-chain
        // Solana fill needs nothing at all: `fill` already created the
        // LocalAttestation that `finalise` reads, so there is no separate
        // attestation step to mirror Tron's `setAttestation`.
        if (isSolanaChain(output.chainId)) {
          const { solver, timestamp } = await getFillDetails(orderId, output, fillTransactionHash);
          if (output.chainId === BigInt(sourceChainId)) {
            if (postHook) await postHook();
            return;
          }
          const signature = await submitSolanaFillProof(await solanaDeps(output.chainId), {
            orderId,
            output,
            solverBytes32: solver,
            timestamp
          });
          if (postHook) await postHook();
          return signature;
        }

        // A Solana INPUT chain receives the proof instead: the oracle writes
        // the attestation account that `finalise` looks for. Everything up to
        // the proof request is the shared EVM path below, so this branch is
        // handled after the proof has been fetched.
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

        if (isSolanaChain(sourceChainId)) {
          // Receiving a proof ON Solana needs two things this app cannot yet
          // determine: the Polymer prover's program id (readable from the
          // OraclePolymer account) and the seeds of its cache/result/internal
          // scratch PDAs, which are only documented in a stale reference test.
          // `receiveProof` in $lib/solana/writes is written and tested against
          // the DI seam; it is deliberately not called with guessed accounts.
          //
          // Failing here — rather than falling through to the EVM path, which
          // would call getClient() on a Solana chain id — keeps the blocker
          // legible. See the unverified list in
          // tests/fixtures/solana/PREFLIGHT.md.
          throw new Error(
            `Receiving a Polymer proof on Solana is not wired up yet: the prover program id and its scratch-PDA seeds must be confirmed on chain first (see tests/fixtures/solana/PREFLIGHT.md). The proof itself was fetched successfully for chain ${Number(sourceChainId)}.`
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
      // and requires the caller to be that owner.
      //
      // Compared as bytes32 on Solana: a Solana solver identity IS 32 bytes, so
      // truncating it to the low 20 (as the EVM comparison does) would never
      // match the connected wallet and would reject the rightful solver.
      const solverBytes32 = solveParams[0].solver;
      const connected = account();
      const ownerMatches = isSolanaChain(sourceChainId)
        ? solverBytes32.toLowerCase() === connected.toLowerCase()
        : bytes32ToAddress(solverBytes32).toLowerCase() === connected.toLowerCase();
      if (!ownerMatches) {
        const owner = isSolanaChain(sourceChainId)
          ? bytes32ToSolanaBase58(solverBytes32)
          : bytes32ToAddress(solverBytes32);
        const connectedDisplay = isSolanaChain(sourceChainId)
          ? bytes32ToSolanaBase58(connected)
          : connected;
        throw new Error(
          `This order was filled for solver ${owner} — connect that wallet to claim (connected: ${connectedDisplay}).`
        );
      }

      if (isSolanaChain(sourceChainId)) {
        if (!(intent instanceof StandardSolanaIntent)) {
          throw new Error("A Solana-input order must be a StandardSolanaIntent");
        }
        const signature = await finaliseSolana(await solanaDeps(BigInt(sourceChainId)), {
          order: intent.asOrder(),
          orderId: intent.orderId(),
          solveParams,
          destinationBytes32: addressToBytes32(account())
        });
        if (postHook) await postHook();
        return signature;
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

      if (intent instanceof StandardSolanaIntent) {
        // Reachable only if the order's namespace and its source chain id
        // disagree, which means the container is malformed rather than that
        // some path is unimplemented.
        throw new Error(
          `Order is a Solana intent but its source chain ${sourceChainId} is not a Solana chain`
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
