import { addressToBytes32, bytes32ToAddress, BYTES32_ZERO } from "@lifi/intent";
import type { EVMOrder, MandateOutput, StandardEVMIntent } from "@lifi/intent";
import { TRON_MAINNET_INPUT_SETTLER } from "@lifi/intent";
import { TRON_INPUT_SETTLER_ABI, TRON_OUTPUT_SETTLER_ABI } from "$lib/abi/tron";
import { ERC20_ABI } from "$lib/abi/erc20";
import {
  maxResolvedAmount,
  nativeValueOfInputs,
  nativeValueOfOutputs,
  orderToTuple,
  outputToTuple,
  solveParamsToTuples,
  solverToFillerData,
  toCallValue
} from "./encode";
import { getTrc20Allowance, toTronAddress } from "./reads";
import { assertTronMainnet, waitForTronTransaction } from "./signer";
import type { TronDeps } from "./types";

const OPEN_FEE_LIMIT = 300_000_000; // 300 TRX
const FILL_FEE_LIMIT = 300_000_000;
const APPROVE_FEE_LIMIT = 100_000_000;
const ORACLE_FEE_LIMIT = 300_000_000;

const MAX_UINT256 = `0x${"ff".repeat(32)}`;

// Order types whose resolved fill amount equals output.amount (limit /
// exclusive-limit, or empty context). Dutch auctions (0x01 / 0xe1) can
// resolve ABOVE output.amount, so a callValue computed from it would
// underfund the fill — native auction outputs are rejected until resolved-
// amount computation lands.
function isFixedAmountContext(context: string): boolean {
  const hex = context.replace(/^0x/, "").toLowerCase();
  if (hex.length === 0) return true;
  const typeByte = hex.substring(0, 2);
  return typeByte === "00" || typeByte === "e0";
}

function assertNativeOutputsAreFixedAmount(outputs: readonly MandateOutput[]): void {
  for (const output of outputs) {
    if (output.token === BYTES32_ZERO && !isFixedAmountContext(output.context)) {
      throw new Error(
        "Native TRX outputs with auction contexts are not supported — the resolved amount can exceed output.amount"
      );
    }
  }
}

async function signerContract(deps: TronDeps, abi: readonly unknown[], addressHex: string) {
  return deps.signer.contract([...abi] as unknown[], toTronAddress(deps.signer, addressHex));
}

function requireSignerAccount(deps: TronDeps): { base58: string; hex: `0x${string}` } {
  const base58 = deps.signer.defaultAddress?.base58;
  const hex = deps.signer.defaultAddress?.hex;
  if (typeof base58 !== "string" || typeof hex !== "string") {
    throw new Error("TronLink is not connected");
  }
  return {
    base58,
    hex: `0x${hex.replace(/^0x/, "").replace(/^41/, "")}` as `0x${string}`
  };
}

/** Approves `spender` for max uint256 on `token` and waits for inclusion —
 * Tron has no account-nonce ordering, so a dependent call broadcast before
 * the approval is mined can land first and revert. */
export async function approveToken(
  deps: TronDeps,
  tokenHex: `0x${string}`,
  spenderHex: `0x${string}`
): Promise<string> {
  await assertTronMainnet(deps.signer, deps.reads);
  const contract = await signerContract(deps, ERC20_ABI, tokenHex);
  const txId = await contract.approve!(toTronAddress(deps.signer, spenderHex), MAX_UINT256).send({
    feeLimit: APPROVE_FEE_LIMIT
  });
  await waitForTronTransaction(deps.reads, txId, { mode: "inclusion" });
  return txId;
}

async function ensureAllowances(
  deps: TronDeps,
  spenderHex: `0x${string}`,
  requirements: Map<string, bigint>
): Promise<void> {
  const account = requireSignerAccount(deps);
  for (const [tokenHex, required] of requirements) {
    if (required === 0n) continue;
    const current = await getTrc20Allowance(
      deps.reads,
      tokenHex as `0x${string}`,
      account.hex,
      spenderHex
    );
    if (current < required) {
      await approveToken(deps, tokenHex as `0x${string}`, spenderHex);
    }
  }
}

/** Opens an escrow intent on the canonical Tron input settler. Native (zero
 * token) inputs are attached as callValue (the deployed `open` is payable);
 * TRC-20 inputs are approved and confirmed before `open` is broadcast. */
export async function openEscrow(deps: TronDeps, intent: StandardEVMIntent): Promise<string> {
  await assertTronMainnet(deps.signer, deps.reads);
  const order = intent.asOrder() as EVMOrder;

  // The contract pulls inputs from msg.sender, but ownership and refunds
  // belong to order.user — a TronLink account switched after the order was
  // built would fund an order it does not own.
  const signerAccount = requireSignerAccount(deps);
  if (signerAccount.hex.toLowerCase() !== order.user.toLowerCase()) {
    throw new Error(
      `TronLink account ${signerAccount.hex} does not match the order's user ${order.user} — switch accounts or rebuild the order`
    );
  }

  // Aggregate required allowance per TRC-20 input token (native inputs skip approval).
  const requirements = new Map<string, bigint>();
  let nativeValue = 0n;
  for (const [tokenId, amount] of order.inputs) {
    const tokenHex = `0x${tokenId.toString(16).padStart(64, "0").slice(24)}` as `0x${string}`;
    if (BigInt(tokenHex) === 0n) {
      nativeValue += amount;
      continue;
    }
    requirements.set(
      tokenHex.toLowerCase(),
      (requirements.get(tokenHex.toLowerCase()) ?? 0n) + amount
    );
  }
  const expectedNative = nativeValueOfInputs(order.inputs);
  if (nativeValue !== expectedNative) {
    throw new Error("Native input aggregation mismatch"); // defensive: two code paths must agree
  }

  await ensureAllowances(deps, intent.inputSettler, requirements);

  const contract = await signerContract(deps, TRON_INPUT_SETTLER_ABI, intent.inputSettler);
  const txId = await contract.open!(
    orderToTuple(order, (hex) => toTronAddress(deps.signer, hex))
  ).send({
    feeLimit: OPEN_FEE_LIMIT,
    ...(nativeValue > 0n ? { callValue: toCallValue(nativeValue) } : {})
  });
  await waitForTronTransaction(deps.reads, txId, { mode: "inclusion" });
  return txId;
}

/** Fills the given outputs on their (shared) output settler. The solver
 * identity is passed explicitly and encoded as fillerData; native outputs
 * attach callValue (limit contexts only). */
export async function fillOutputs(
  deps: TronDeps,
  args: {
    orderId: `0x${string}`;
    outputs: MandateOutput[];
    fillDeadline: number;
    solverBytes32: `0x${string}`;
  }
): Promise<string> {
  await assertTronMainnet(deps.signer, deps.reads);
  const { orderId, outputs, fillDeadline, solverBytes32 } = args;

  const [first] = outputs;
  if (!first) throw new Error("No outputs to fill");
  if (!outputs.every((o) => o.settler === first.settler)) {
    throw new Error("Different settlers on outputs, not supported");
  }
  assertNativeOutputsAreFixedAmount(outputs);

  const settlerHex = bytes32ToAddress(first.settler);

  // Aggregate allowance per token across outputs (a per-output check would
  // under-approve when two outputs share a token).
  const requirements = new Map<string, bigint>();
  for (const output of outputs) {
    if (output.token === BYTES32_ZERO) continue;
    const tokenHex = bytes32ToAddress(output.token).toLowerCase();
    // Auction outputs can resolve above output.amount — size the allowance
    // for the worst case or the fill reverts after consuming energy.
    requirements.set(tokenHex, (requirements.get(tokenHex) ?? 0n) + maxResolvedAmount(output));
  }
  await ensureAllowances(deps, settlerHex, requirements);

  const nativeValue = nativeValueOfOutputs(outputs);

  const contract = await signerContract(deps, TRON_OUTPUT_SETTLER_ABI, settlerHex);
  const txId = await contract.fillOrderOutputs!(
    orderId,
    outputs.map(outputToTuple),
    fillDeadline,
    solverToFillerData(solverBytes32)
  ).send({
    feeLimit: FILL_FEE_LIMIT,
    ...(nativeValue > 0n ? { callValue: toCallValue(nativeValue) } : {})
  });
  await waitForTronTransaction(deps.reads, txId, { mode: "inclusion" });
  return txId;
}

// Use only the single-bytes overload so TronLink's ethers does not pick bytes[].
const RECEIVE_MESSAGE_SINGLE_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    inputs: [{ name: "proof", type: "bytes", internalType: "bytes" }],
    outputs: [],
    stateMutability: "nonpayable"
  }
] as const;

export async function submitReceiveMessage(
  deps: TronDeps,
  oracleHex: `0x${string}`,
  proof: string
): Promise<string> {
  await assertTronMainnet(deps.signer, deps.reads);
  const contract = await signerContract(deps, RECEIVE_MESSAGE_SINGLE_ABI, oracleHex);
  const proofBytes = `0x${proof.replace(/^0x/, "")}`;
  const txId = await contract.receiveMessage!(proofBytes).send({ feeLimit: ORACLE_FEE_LIMIT });
  await waitForTronTransaction(deps.reads, txId, { mode: "confirmed" });
  return txId;
}

/** Same-chain proving: fills record `_fillRecords`, but `finalise` verifies
 * `_attestations` — the filler must call `setAttestation` on the output
 * settler after the fill for a same-chain order to become claimable. */
export async function setAttestation(
  deps: TronDeps,
  args: {
    outputSettlerBytes32: `0x${string}`;
    orderId: `0x${string}`;
    solverBytes32: `0x${string}`;
    timestamp: number;
    output: MandateOutput;
  }
): Promise<string> {
  await assertTronMainnet(deps.signer, deps.reads);
  const settlerHex = bytes32ToAddress(args.outputSettlerBytes32);
  const contract = await signerContract(deps, TRON_OUTPUT_SETTLER_ABI, settlerHex);
  const txId = await contract.setAttestation!(
    args.orderId,
    args.solverBytes32,
    args.timestamp,
    outputToTuple(args.output)
  ).send({ feeLimit: ORACLE_FEE_LIMIT });
  await waitForTronTransaction(deps.reads, txId, { mode: "confirmed" });
  return txId;
}

/** Finalises (claims) an order on its input settler. `solveParams` must be
 * the event-derived (timestamp, solver) pairs; the contract requires
 * msg.sender to be the order owner derived from solveParams[0].solver, so
 * callers must pre-check the connected account against it. */
export async function finalise(
  deps: TronDeps,
  args: {
    inputSettler: `0x${string}`;
    order: EVMOrder;
    solveParams: { timestamp: number; solver: `0x${string}` }[];
    destinationBytes32: `0x${string}`;
  }
): Promise<string> {
  await assertTronMainnet(deps.signer, deps.reads);
  const { inputSettler, order, solveParams, destinationBytes32 } = args;

  const [firstParam] = solveParams;
  if (!firstParam) throw new Error("finalise requires at least one solveParam");
  const account = requireSignerAccount(deps);
  const expectedOwner = bytes32ToAddress(firstParam.solver).toLowerCase();
  if (expectedOwner !== account.hex.toLowerCase()) {
    throw new Error(
      `This order was filled for solver ${firstParam.solver} — connect that wallet to claim (connected: ${addressToBytes32(account.hex)})`
    );
  }

  const contract = await signerContract(deps, TRON_INPUT_SETTLER_ABI, inputSettler);
  const txId = await contract.finalise!(
    orderToTuple(order, (hex) => toTronAddress(deps.signer, hex)),
    solveParamsToTuples(solveParams),
    destinationBytes32,
    "0x"
  ).send({ feeLimit: OPEN_FEE_LIMIT });
  await waitForTronTransaction(deps.reads, txId, { mode: "inclusion" });
  return txId;
}

export { TRON_MAINNET_INPUT_SETTLER };
