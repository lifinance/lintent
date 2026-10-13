import {
  Account,
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr
} from "@stellar/stellar-sdk";
import {
  bytes32ToStellarContract,
  encodeStellarMandateOutput,
  encodeStellarOrder,
  encodeStellarSolves,
  inputSettlerForStellar,
  outputSettlerForStellar,
  STELLAR_MAINNET_CHAIN_ID,
  type MandateOutput,
  type StandardStellarIntent
} from "@lifi/intent";
import { bytesToHex, hexToBytes } from "viem";
import {
  AXELAR_ORACLE,
  BYTES32_ZERO,
  STELLAR_CHAIN_ID,
  STELLAR_NETWORK_PASSPHRASE,
  STELLAR_RPC_URL
} from "$lib/config";
import { signStellarTransaction } from "$lib/utils/stellarWallet";

const server = new rpc.Server(STELLAR_RPC_URL);

const BASE_FEE = "10000";
const TX_TIMEOUT_SECONDS = 180;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;
// Ledgers (~5 s each) an output-token allowance stays valid for the fill.
const APPROVAL_LEDGERS = 1_000;

const ESCROW = bytes32ToStellarContract(inputSettlerForStellar(STELLAR_MAINNET_CHAIN_ID));
const OUTPUT_SETTLER = bytes32ToStellarContract(outputSettlerForStellar(STELLAR_MAINNET_CHAIN_ID));
const AXELAR_ORACLE_CONTRACT = bytes32ToStellarContract(AXELAR_ORACLE[STELLAR_CHAIN_ID]!);

export type StellarTransaction = {
  hash: `0x${string}`;
  ledger: number;
  createdAt: number;
};

// -- ScVal helpers ------------------------------------------------------------ //

const scBytes = (hex: `0x${string}`) => nativeToScVal(hexToBytes(hex));
const scI128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
const scAddress = (strkey: string) => new Address(strkey).toScVal();
/** ScVal produced by the @lifi/intent Soroban encoders. */
const fromLibXdr = (bytes: Uint8Array) => xdr.ScVal.fromXDR(bytes);

// -- Plumbing ------------------------------------------------------------------ //

function contractCall(source: Account, contractId: string, method: string, args: xdr.ScVal[]) {
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_NETWORK_PASSPHRASE
  })
    .addOperation(
      Operation.invokeContractFunction({ contract: contractId, function: method, args })
    )
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
}

/** Simulates a read-only contract call and returns its return value. */
async function simulateRead(contractId: string, method: string, args: xdr.ScVal[]) {
  const tx = contractCall(new Account(Keypair.random().publicKey(), "0"), contractId, method, args);
  const result = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(result) || !result.result)
    throw new Error(
      `Stellar simulation failed: ${"error" in result ? result.error : "no return value"}`
    );
  return result.result.retval;
}

/**
 * Builds, simulates (footprint + source-account auth), signs with the
 * connected wallet and submits a contract call, then waits for inclusion.
 */
async function invokeStellar(opts: {
  source: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}): Promise<StellarTransaction> {
  const { source, contractId, method, args } = opts;
  const tx = contractCall(await server.getAccount(source), contractId, method, args);
  const prepared = await server.prepareTransaction(tx);
  const signed = await signStellarTransaction(prepared.toXDR(), source);
  const sent = await server.sendTransaction(
    TransactionBuilder.fromXDR(signed, STELLAR_NETWORK_PASSPHRASE)
  );
  if (sent.status === "ERROR")
    throw new Error(
      `Stellar transaction rejected: ${sent.errorResult?.toXDR("base64") ?? sent.hash}`
    );

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await server.getTransaction(sent.hash);
    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS)
      return { hash: `0x${sent.hash}`, ledger: status.ledger, createdAt: status.createdAt };
    if (status.status === rpc.Api.GetTransactionStatus.FAILED)
      throw new Error(`Stellar transaction failed: ${sent.hash}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, POLL_INTERVAL_MS);
    await promise;
  }
  throw new Error(`Stellar transaction not confirmed after 90 s: ${sent.hash}`);
}

function requireSource(source: string | undefined): string {
  if (!source) throw new Error("Connect a Stellar wallet first");
  return source;
}

// -- Reads ------------------------------------------------------------------- //

/** SAC `balance(id)` of a G account, by the token's raw 32-byte contract id. */
export async function stellarTokenBalance(token: `0x${string}`, account: string): Promise<bigint> {
  const balance = await simulateRead(bytes32ToStellarContract(token), "balance", [
    scAddress(account)
  ]);
  return BigInt(scValToNative(balance));
}

/** Escrow `order_status`: 0 Deposited, 1 Claimed, 2 Refunded, undefined unknown. */
export async function stellarOrderStatus(orderId: `0x${string}`): Promise<number | undefined> {
  const status = scValToNative(await simulateRead(ESCROW, "order_status", [scBytes(orderId)]));
  return status == null ? undefined : Number(status);
}

/** OutputSettler fill record `keccak256(solver ‖ u32 timestamp)`, if filled. */
export async function stellarFillRecord(
  orderId: `0x${string}`,
  outputHash: `0x${string}`
): Promise<`0x${string}` | undefined> {
  const record = scValToNative(
    await simulateRead(OUTPUT_SETTLER, "get_fill_record", [scBytes(orderId), scBytes(outputHash)])
  );
  return record == null ? undefined : bytesToHex(record as Uint8Array);
}

/** Stellar AxelarOracle `is_proven(chain, oracle, application, hash)`. */
export async function stellarIsProven(
  oracle: `0x${string}`,
  chainId: bigint,
  remoteOracle: `0x${string}`,
  application: `0x${string}`,
  dataHash: `0x${string}`
): Promise<boolean> {
  const proven = await simulateRead(bytes32ToStellarContract(oracle), "is_proven", [
    nativeToScVal(BigInt(chainId), { type: "u256" }),
    scBytes(remoteOracle),
    scBytes(application),
    scBytes(dataHash)
  ]);
  return scValToNative(proven) === true;
}

/** Ledger and close time of an included transaction, or undefined if RPC no longer has it. */
export async function getStellarTransaction(
  hash: `0x${string}`
): Promise<{ ledger: number; createdAt: number } | undefined> {
  const tx = await server.getTransaction(hash.replace(/^0x/, ""));
  if (tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return undefined;
  if (tx.status === rpc.Api.GetTransactionStatus.FAILED)
    throw new Error(`Stellar transaction ${hash} failed`);
  return { ledger: tx.ledger, createdAt: tx.createdAt };
}

// -- Writes ------------------------------------------------------------------ //

/** Escrow `open(order)`, authorised by the user as transaction source. */
export function openStellarIntent(intent: StandardStellarIntent, source: string | undefined) {
  return invokeStellar({
    source: requireSource(source),
    contractId: ESCROW,
    method: "open",
    args: [fromLibXdr(encodeStellarOrder(intent.asOrder()))]
  });
}

/**
 * Approves the OutputSettler for each output token, then fills the outputs.
 * The settler pulls payment with `transfer_from`, so the approvals must land
 * first.
 */
export async function fillStellarOutputs(opts: {
  orderId: `0x${string}`;
  outputs: MandateOutput[];
  fillDeadline: number;
  solver: `0x${string}`;
  source: string | undefined;
}): Promise<StellarTransaction> {
  const { orderId, outputs, fillDeadline, solver } = opts;
  const source = requireSource(opts.source);
  const totals: Record<`0x${string}`, bigint> = {};
  for (const output of outputs) {
    const token = output.token.toLowerCase() as `0x${string}`;
    totals[token] = (totals[token] ?? 0n) + BigInt(output.amount);
  }
  for (const [token, amount] of Object.entries(totals) as [`0x${string}`, bigint][]) {
    const { sequence } = await server.getLatestLedger();
    await invokeStellar({
      source,
      contractId: bytes32ToStellarContract(token),
      method: "approve",
      args: [
        scAddress(source),
        scAddress(OUTPUT_SETTLER),
        scI128(amount),
        nativeToScVal(sequence + APPROVAL_LEDGERS, { type: "u32" })
      ]
    });
  }
  return invokeStellar({
    source,
    contractId: OUTPUT_SETTLER,
    method: "fill_order_outputs",
    args: [
      scAddress(source),
      scBytes(solver),
      scBytes(orderId),
      xdr.ScVal.scvVec(outputs.map((output) => fromLibXdr(encodeStellarMandateOutput(output)))),
      nativeToScVal(Number(fillDeadline), { type: "u32" })
    ]
  });
}

/** Escrow `finalise`, paying the inputs to the connected account. */
export function finaliseStellarIntent(opts: {
  intent: StandardStellarIntent;
  solves: { solver: `0x${string}`; timestamp: number }[];
  source: string | undefined;
}) {
  const source = requireSource(opts.source);
  return invokeStellar({
    source,
    contractId: ESCROW,
    method: "finalise",
    args: [
      fromLibXdr(encodeStellarOrder(opts.intent.asOrder())),
      fromLibXdr(encodeStellarSolves(opts.solves)),
      scAddress(source),
      scAddress(source)
    ]
  });
}

/** Stellar AxelarOracle `submit`: relays fill payloads proven by the OutputSettler. */
export function submitStellarAxelar(opts: {
  destinationChain: string;
  recipientOracle: `0x${string}`;
  payloads: `0x${string}`[];
  gasAmount: bigint;
  source: string | undefined;
}) {
  const source = requireSource(opts.source);
  return invokeStellar({
    source,
    contractId: AXELAR_ORACLE_CONTRACT,
    method: "submit",
    args: [
      nativeToScVal(opts.destinationChain, { type: "string" }),
      scBytes(opts.recipientOracle),
      scAddress(OUTPUT_SETTLER),
      xdr.ScVal.scvVec(opts.payloads.map(scBytes)),
      scAddress(source),
      scI128(opts.gasAmount),
      scBytes(BYTES32_ZERO),
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Relayed")])
    ]
  });
}
