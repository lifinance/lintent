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
  encodeFillDescription,
  inputSettlerForStellar,
  outputSettlerForStellar,
  type MandateOutput,
  type StandardStellarIntent
} from "@lifi/intent";
import { bytesToHex, hexToBytes } from "viem";
import {
  AXELAR_ORACLE,
  BYTES32_ZERO,
  stellarNetwork,
  stellarDeployment,
  AXELAR_CHAIN_NAMES,
  requireAlignedAxelar
} from "$lib/config";
import { signStellarTransaction } from "$lib/utils/stellarWallet";

const stellarServer = (chainId: number | bigint) => new rpc.Server(stellarNetwork(chainId).rpc);

const BASE_FEE = "10000";
const TX_TIMEOUT_SECONDS = 180;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;
// Ledgers (~5 s each) an output-token allowance stays valid for the fill.
const APPROVAL_LEDGERS = 1_000;

const escrow = (chainId: number | bigint) =>
  bytes32ToStellarContract(inputSettlerForStellar(BigInt(chainId), stellarDeployment));
const outputSettler = (chainId: number | bigint) =>
  bytes32ToStellarContract(outputSettlerForStellar(BigInt(chainId), stellarDeployment));

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

function contractCall(
  chainId: number | bigint,
  source: Account,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
) {
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork(chainId).passphrase
  })
    .addOperation(
      Operation.invokeContractFunction({ contract: contractId, function: method, args })
    )
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
}

/** Simulates a read-only contract call and returns its return value. */
async function simulateRead(
  chainId: number | bigint,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
) {
  const tx = contractCall(
    chainId,
    new Account(Keypair.random().publicKey(), "0"),
    contractId,
    method,
    args
  );
  const result = await stellarServer(chainId).simulateTransaction(tx);
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
  chainId: number | bigint;
  source: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  beforeSign?: () => void;
}): Promise<StellarTransaction> {
  const { chainId, source, contractId, method, args } = opts;
  const server = stellarServer(chainId);
  const tx = contractCall(chainId, await server.getAccount(source), contractId, method, args);
  const prepared = await server.prepareTransaction(tx);
  const signed = await signStellarTransaction(
    prepared.toXDR(),
    source,
    Number(chainId),
    opts.beforeSign
  );
  const sent = await server.sendTransaction(
    TransactionBuilder.fromXDR(signed, stellarNetwork(chainId).passphrase)
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
export async function stellarTokenBalance(
  chainId: number | bigint,
  token: `0x${string}`,
  account: string
): Promise<bigint> {
  const balance = await simulateRead(chainId, bytes32ToStellarContract(token), "balance", [
    scAddress(account)
  ]);
  return BigInt(scValToNative(balance));
}

/** Escrow `order_status`: 0 Deposited, 1 Claimed, 2 Refunded, undefined unknown. */
export async function stellarOrderStatus(
  chainId: number | bigint,
  orderId: `0x${string}`
): Promise<number | undefined> {
  const status = scValToNative(
    await simulateRead(chainId, escrow(chainId), "order_status", [scBytes(orderId)])
  );
  return status == null ? undefined : Number(status);
}

/** OutputSettler fill record `keccak256(solver ‖ u32 timestamp)`, if filled. */
export async function stellarFillRecord(
  chainId: number | bigint,
  orderId: `0x${string}`,
  outputHash: `0x${string}`
): Promise<`0x${string}` | undefined> {
  const record = scValToNative(
    await simulateRead(chainId, outputSettler(chainId), "get_fill_record", [
      scBytes(orderId),
      scBytes(outputHash)
    ])
  );
  return record == null ? undefined : bytesToHex(record as Uint8Array);
}

/** Stellar AxelarOracle `is_proven(chain, oracle, application, hash)`. */
export async function stellarIsProven(
  localChainId: number | bigint,
  oracle: `0x${string}`,
  chainId: bigint,
  remoteOracle: `0x${string}`,
  application: `0x${string}`,
  dataHash: `0x${string}`
): Promise<boolean> {
  const proven = await simulateRead(localChainId, bytes32ToStellarContract(oracle), "is_proven", [
    nativeToScVal(BigInt(chainId), { type: "u256" }),
    scBytes(remoteOracle),
    scBytes(application),
    scBytes(dataHash)
  ]);
  return scValToNative(proven) === true;
}

/** Ledger and close time of an included transaction, or undefined if RPC no longer has it. */
export async function getStellarTransaction(
  chainId: number | bigint,
  hash: `0x${string}`
): Promise<{ ledger: number; createdAt: number } | undefined> {
  const tx = await stellarServer(chainId).getTransaction(hash.replace(/^0x/, ""));
  if (tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return undefined;
  if (tx.status === rpc.Api.GetTransactionStatus.FAILED)
    throw new Error(`Stellar transaction ${hash} failed`);
  return { ledger: tx.ledger, createdAt: tx.createdAt };
}

/** Resolve an external solver from a successful, exact-output contract event. */
export async function stellarFillEvent(
  chainId: number | bigint,
  hash: `0x${string}`,
  orderId: `0x${string}`,
  output: MandateOutput
) {
  const server = stellarServer(chainId);
  const tx = await server.getTransaction(hash.replace(/^0x/, ""));
  if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS)
    throw new Error("Stellar fill transaction not successful");
  const events = await server.getEvents({
    startLedger: tx.ledger,
    endLedger: tx.ledger + 1,
    filters: [
      {
        type: "contract",
        contractIds: [outputSettler(chainId)],
        topics: [
          [xdr.ScVal.scvSymbol("output_filled").toXDR("base64"), scBytes(orderId).toXDR("base64")]
        ]
      }
    ]
  });
  for (const event of events.events) {
    if (
      event.txHash !== hash.replace(/^0x/, "") ||
      !event.inSuccessfulContractCall ||
      event.contractId?.contractId() !== outputSettler(chainId) ||
      event.ledger !== tx.ledger ||
      event.topic.length !== 2 ||
      event.topic[0].toXDR("base64") !== xdr.ScVal.scvSymbol("output_filled").toXDR("base64") ||
      event.topic[1].toXDR("base64") !== scBytes(orderId).toXDR("base64")
    )
      continue;
    const data: unknown = scValToNative(event.value);
    if (
      !data ||
      typeof data !== "object" ||
      !("payload" in data) ||
      !(data.payload instanceof Uint8Array) ||
      !("oracle" in data) ||
      !(data.oracle instanceof Uint8Array) ||
      bytesToHex(data.oracle) !== output.oracle
    )
      continue;
    const payload = data.payload;
    if (payload.length < 72) continue;
    const solver = bytesToHex(payload.subarray(4, 36));
    const timestamp = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength
    ).getUint32(68);
    const expected = encodeFillDescription({ solver, orderId, timestamp, output });
    if (bytesToHex(payload) === expected) return { solver, timestamp, payload: expected };
  }
  throw new Error("No matching Stellar output_filled event in successful transaction");
}

// -- Writes ------------------------------------------------------------------ //

/** Escrow `open(order)`, authorised by the user as transaction source. */
export function openStellarIntent(intent: StandardStellarIntent, source: string | undefined) {
  return openStellarApiOrder(
    intent.asOrder().originChainId,
    bytes32ToStellarContract(intent.inputSettler),
    fromLibXdr(encodeStellarOrder(intent.asOrder())),
    source
  );
}

/** The API payload is an order ScVal, not a signed transaction envelope. */
export function openStellarApiOrder(
  chainId: number | bigint,
  contractId: string,
  order: xdr.ScVal,
  source: string | undefined,
  beforeSign?: () => void
) {
  if (contractId !== escrow(chainId)) throw new Error("Unexpected Stellar escrow");
  return invokeStellar({
    chainId,
    source: requireSource(source),
    contractId,
    method: "open",
    args: [order],
    beforeSign
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
  const chainId = outputs[0].chainId;
  const server = stellarServer(chainId);
  const OUTPUT_SETTLER = outputSettler(chainId);
  const source = requireSource(opts.source);
  const totals: Record<`0x${string}`, bigint> = {};
  for (const output of outputs) {
    const token = output.token.toLowerCase() as `0x${string}`;
    totals[token] = (totals[token] ?? 0n) + BigInt(output.amount);
  }
  for (const [token, amount] of Object.entries(totals) as [`0x${string}`, bigint][]) {
    const { sequence } = await server.getLatestLedger();
    await invokeStellar({
      chainId,
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
    chainId,
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
    chainId: opts.intent.asOrder().originChainId,
    source,
    contractId: escrow(opts.intent.asOrder().originChainId),
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
export async function submitStellarAxelar(opts: {
  chainId: number | bigint;
  destinationChainId: bigint;
  recipientOracle: string;
  payloads: `0x${string}`[];
  gasAmount: bigint;
  source: string | undefined;
}) {
  const source = requireSource(opts.source);
  requireAlignedAxelar(opts.chainId, opts.destinationChainId);
  if (opts.gasAmount <= 0n) throw new Error("Paid Relayed gas must be positive");
  const oracle = bytes32ToStellarContract(AXELAR_ORACLE[Number(opts.chainId)]!);
  const name = AXELAR_CHAIN_NAMES[Number(opts.destinationChainId)]!;
  const domain = await simulateRead(opts.chainId, oracle, "route", [
    nativeToScVal(name, { type: "string" })
  ]);
  const reverse = await simulateRead(opts.chainId, oracle, "chain_name", [
    nativeToScVal(opts.destinationChainId, { type: "u256" })
  ]);
  if (BigInt(scValToNative(domain)) !== opts.destinationChainId || scValToNative(reverse) !== name)
    throw new Error("Stellar Axelar forward/reverse chain map mismatch");
  return invokeStellar({
    chainId: opts.chainId,
    source,
    contractId: bytes32ToStellarContract(AXELAR_ORACLE[Number(opts.chainId)]!),
    method: "submit",
    args: [
      nativeToScVal(opts.destinationChainId, { type: "u256" }),
      nativeToScVal(opts.recipientOracle, { type: "string" }),
      scAddress(outputSettler(opts.chainId)),
      xdr.ScVal.scvVec(opts.payloads.map(scBytes)),
      scAddress(source),
      scI128(opts.gasAmount),
      scBytes(BYTES32_ZERO),
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Relayed")])
    ]
  });
}
