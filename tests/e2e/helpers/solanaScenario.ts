// Browser-only test fixture. All chain reads, simulations and broadcasts are
// replaced here; the real wallet adapter, builders, persistence and UI run.
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { base58 } from "@scure/base";
import { SOLANA_MAINNET_CHAIN_ID, type StandardSolana, type OrderContainer } from "@lifi/intent";
import store from "$lib/state.svelte";
import { coinList, clients } from "$lib/config";
import { getSolanaReads, SOLANA_GENESIS_HASHES } from "$lib/solana/client";
import { connectSolanaWallet, listSolanaWallets } from "$lib/solana/wallet";
import { CLOCK_SYSVAR } from "$lib/solana/reads";
import {
  TOKEN_PROGRAM_ID,
  inputSettlerEscrowPda,
  outputSettlerSimplePda,
  orderContextPda,
  consumedOrderPda,
  pubkeyToBytes32,
  fillIdPda
} from "$lib/solana/pda";
import { solanaOrderId } from "$lib/solana/order";
import { reviveOrderBigInts } from "$lib/utils/intent";
import { getOutputHash } from "@lifi/intent";
import { INPUT_SETTLER_ESCROW_PROGRAM_ID, OUTPUT_SETTLER_SIMPLE_PROGRAM_ID } from "$lib/idl";
import inputIdl from "$lib/idl/input_settler_escrow.json";
import outputIdl from "$lib/idl/output_settler_simple.json";
import {
  clockData,
  contextData,
  fillRecordData,
  localAttestationData
} from "../../fixtures/solana/accounts";
import { fillReceipt, settlementLogs } from "../../fixtures/solana/transactions";
import { localAttestationPda } from "$lib/solana/pda";
import { localAttestationDataHash } from "$lib/solana/encode";
import { INTENTS_PROTOCOL_PROGRAM_ID } from "$lib/idl";
import type { SolanaTransactionLike } from "$lib/solana/types";

let signed = 0;
let simulated = 0;
const submissions: string[][] = [];
const transactionReads: Record<string, number> = {};
let clock = Math.floor(Date.now() / 1000);
let simulationFailure = false;
let currentOrder: StandardSolana;

export function inspectScenario() {
  return { signed, simulated, submissions, transactionReads };
}
export function makeRentReclaimable() {
  clock = currentOrder.fillDeadline + 172801;
}

const saveReceipt = store.saveTransactionReceipt.bind(store);
export function receiptStorageAvailable(available: boolean) {
  store.saveTransactionReceipt = available
    ? saveReceipt
    : async () => {
        throw new Error("Local receipt storage is unavailable");
      };
}

export async function installScenario(
  options: {
    simulationFailure?: boolean;
    restore?: boolean;
    noPreset?: boolean;
    singleReceiptRead?: boolean;
  } = {}
) {
  simulationFailure = !!options.simulationFailure;
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(1));
  const user = pubkeyToBytes32(wallet.publicKey);
  const chain = SOLANA_MAINNET_CHAIN_ID;
  const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const settler = pubkeyToBytes32(outputSettlerSimplePda());
  const saved = localStorage.getItem("solana-test-order");
  const order: StandardSolana =
    options.restore && saved
      ? (reviveOrderBigInts(JSON.parse(saved)) as StandardSolana)
      : {
          user,
          nonce: 7n,
          originChainId: chain,
          expires: clock + 1200,
          fillDeadline: clock + 600,
          inputOracle: settler,
          inputs: [[BigInt(pubkeyToBytes32(mint)), 1_000_000n]],
          outputs: [
            {
              oracle: settler,
              settler,
              chainId: chain,
              token: pubkeyToBytes32(mint),
              amount: 900_000n,
              recipient: user,
              context: "0x",
              callbackData: "0x"
            }
          ]
        };
  currentOrder = order;
  const id = solanaOrderId(order);
  let settled = options.restore && localStorage.getItem("solana-test-settled") === "true";
  let reclaimed = options.restore && localStorage.getItem("solana-test-reclaimed") === "true";
  let filled = !!settled;
  const receipts = new Map<string, SolanaTransactionLike>();
  const reads = await getSolanaReads(chain);
  reads.getGenesisHash = async () => SOLANA_GENESIS_HASHES[chain.toString()];
  reads.getBalance = async () => 1_000_000_000n;
  reads.getTokenAccountBalance = async () => 10_000_000n;
  const info = (owner: string, data: Uint8Array) => ({ owner, data, lamports: 1_000_000 });
  reads.getAccountInfo = async (address) => {
    if (address === CLOCK_SYSVAR)
      return info("Sysvar1111111111111111111111111111111111111", clockData(clock));
    if (address === mint.toBase58()) return info(TOKEN_PROGRAM_ID, new Uint8Array(82));
    if (address === orderContextPda(id).toBase58())
      return settled
        ? null
        : info(
            INPUT_SETTLER_ESCROW_PROGRAM_ID,
            contextData(mint.toBase58(), wallet.publicKey.toBase58())
          );
    if (address === consumedOrderPda(id).toBase58())
      return info(INPUT_SETTLER_ESCROW_PROGRAM_ID, new Uint8Array(8));
    if (address === fillIdPda(id, getOutputHash(order.outputs[0])).toBase58())
      return filled && !reclaimed
        ? info(
            OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
            fillRecordData(wallet.publicKey.toBase58(), BigInt(order.fillDeadline + 172800))
          )
        : null;
    if (
      address ===
      localAttestationPda(
        outputSettlerSimplePda(),
        settler,
        localAttestationDataHash({ solver: user, orderId: id, output: order.outputs[0] })
      ).toBase58()
    )
      return filled
        ? info(
            INTENTS_PROTOCOL_PROGRAM_ID,
            localAttestationData(wallet.publicKey.toBase58(), clock)
          )
        : null;
    return null;
  };
  reads.getMultipleAccountsInfo = async (addresses) =>
    Promise.all(addresses.map((a) => reads.getAccountInfo(a)));
  reads.getTransaction = async (signature) => {
    transactionReads[signature] = (transactionReads[signature] ?? 0) + 1;
    if (options.singleReceiptRead && transactionReads[signature] > 1)
      throw new Error("RPC history unavailable after confirmation");
    return receipts.get(signature) ?? null;
  };

  Connection.prototype.getLatestBlockhash = async () => ({
    blockhash: mint.toBase58(),
    lastValidBlockHeight: 100
  });
  Connection.prototype.simulateTransaction = (async () => {
    simulated++;
    return {
      context: { slot: 12345 },
      value: {
        err: simulationFailure ? { InstructionError: [1, { Custom: 1 }] } : null,
        logs: simulationFailure ? ["Insufficient output funds"] : [],
        unitsConsumed: 110_000
      }
    };
  }) as never;
  Connection.prototype.sendRawTransaction = async (bytes) => {
    const tx = Transaction.from(bytes);
    const names = tx.instructions.flatMap((ix) => {
      const idl =
        ix.programId.toBase58() === INPUT_SETTLER_ESCROW_PROGRAM_ID
          ? inputIdl
          : ix.programId.toBase58() === OUTPUT_SETTLER_SIMPLE_PROGRAM_ID
            ? outputIdl
            : undefined;
      return idl ? [new BorshInstructionCoder(idl as Idl).decode(ix.data)!.name] : [];
    });
    submissions.push(names);
    const signature = base58.encode(new Uint8Array(64).fill(submissions.length));
    let receipt: SolanaTransactionLike = { slot: 12345, meta: { err: null, logMessages: [] } };
    if (names.includes("fill_samechain") || names.includes("native_fill_samechain")) {
      filled = true;
      settled = true;
      receipt = fillReceipt(order, user, clock);
    } else if (names.includes("fill")) {
      filled = true;
      receipt = fillReceipt(order, user, clock, false);
    } else if (names.includes("finalise")) {
      settled = true;
      receipt.meta!.logMessages = settlementLogs(order, user);
    } else if (names.includes("close_fill_record")) {
      reclaimed = true;
    }
    localStorage.setItem("solana-test-settled", String(settled));
    localStorage.setItem("solana-test-reclaimed", String(reclaimed));
    receipts.set(signature, receipt);
    return signature;
  };
  Connection.prototype.confirmTransaction = (async () => ({
    context: { slot: 12345 },
    value: { err: null }
  })) as never;

  const provider = {
    isPhantom: true,
    isConnected: true,
    publicKey: wallet.publicKey,
    connect: async () => undefined,
    disconnect: async () => undefined,
    on: () => undefined,
    off: () => undefined,
    signTransaction: async (tx: Transaction) => {
      signed++;
      tx.partialSign(wallet);
      return tx;
    }
  };
  Object.assign(window, {
    phantom: { solana: provider },
    solana: provider,
    isPhantomInstalled: true
  });
  for (const client of Object.values(clients)) {
    client.getBalance = async () => 10_000_000n;
    client.readContract = (async () => 10_000_000n) as never;
  }
  await store.dbReady;
  for (let i = 0; i < 50; i++) {
    if (
      (await listSolanaWallets()).some((w) => w.name === "Phantom" && w.readyState === "Installed")
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await connectSolanaWallet("Phantom");
  store.mainnet = true;
  store.intentType = "escrow";
  await store.syncTokensForNetwork(true);
  const token = coinList(true).find((c) => BigInt(c.chainId) === chain && c.name === "usdc")!;
  store.inputTokens = [{ token, amount: 1_000_000n }];
  store.outputTokens = [{ token, amount: 900_000n }];
  const orderContainer = {
    order,
    inputSettler: pubkeyToBytes32(inputSettlerEscrowPda()),
    sponsorSignature: { type: "None", payload: "0x" },
    allocatorSignature: { type: "None", payload: "0x" }
  } as OrderContainer;
  if (!options.noPreset && !options.restore) await store.saveOrderToDb(orderContainer);
  localStorage.setItem("solana-test-order", JSON.stringify(order));
  return { id, user, orderContainer };
}
