import { StandardSolanaIntent, type OrderContainer, type StandardSolana } from "@lifi/intent";
import { isSolanaChain } from "$lib/utils/chainType";
import { inputSettlerEscrowPda, outputSettlerSimplePda, pubkeyToBytes32 } from "./pda";

const U64_MAX = (1n << 64n) - 1n;

export function assertUnsigned(value: bigint | number, bits: number, field: string): void {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  const n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new Error(`${field} must fit in u${bits}`);
}

/** Mirrors the input settler's conservative finalisation-size guard at open. */
export function validateSolanaOrder(order: StandardSolana, sponsor: `0x${string}`): void {
  if (order.inputs.length !== 1) throw new Error("A Solana order must have exactly one input");
  if (BigInt(order.inputs[0][0]) === 0n) {
    throw new Error("Solana escrow requires an SPL mint; use wrapped SOL for native-SOL input.");
  }
  assertUnsigned(order.inputs[0][0], 256, "Input mint");
  assertUnsigned(order.inputs[0][1], 64, "Input amount");
  assertUnsigned(order.nonce, 128, "Nonce");
  assertUnsigned(order.originChainId, 128, "Origin chain");
  assertUnsigned(order.expires, 32, "Expiry");
  assertUnsigned(order.fillDeadline, 32, "Fill deadline");
  if (order.fillDeadline >= order.expires) throw new Error("Fill deadline must precede expiry");
  if (!order.outputs.length) throw new Error("An order must have an output");
  let variableBytes = 0;
  for (const output of order.outputs) {
    assertUnsigned(output.chainId, 256, "Output chain");
    assertUnsigned(output.amount, 256, "Output amount");
    if (
      isSolanaChain(output.chainId) &&
      (BigInt(output.amount) > U64_MAX || output.callbackData !== "0x")
    ) {
      throw new Error("Solana outputs require a u64 amount and empty callback data");
    }
    for (const value of [output.callbackData, output.context]) {
      if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error("Invalid output bytes");
      const size = (value.length - 2) / 2;
      if (size > 65535) throw new Error("Output bytes exceed u16 length");
      variableBytes += size;
    }
  }
  const expectedSize =
    760 +
    302 * order.outputs.length +
    variableBytes -
    (sponsor.toLowerCase() === order.user.toLowerCase() ? 32 : 0);
  if (expectedSize > 1232 - 90) {
    throw new Error(
      "Solana finalisation would exceed the transaction limit. Use one output with a shorter context."
    );
  }
}

/** No new order flag: atomic eligibility is a property of the canonical order. */
export function atomicFillProblem(container: OrderContainer): string | undefined {
  const { order } = container;
  if (!("originChainId" in order) || !isSolanaChain(order.originChainId))
    return "Atomic settlement requires a Solana input.";
  if (
    container.inputSettler.toLowerCase() !== pubkeyToBytes32(inputSettlerEscrowPda()).toLowerCase()
  )
    return "This input settler does not support atomic settlement.";
  if (order.inputs.length !== 1 || order.outputs.length !== 1)
    return "Atomic settlement requires one input and one output.";
  const [output] = order.outputs;
  if (BigInt(output.chainId) !== BigInt(order.originChainId))
    return "Atomic settlement requires a same-chain output.";
  const settler = pubkeyToBytes32(outputSettlerSimplePda()).toLowerCase();
  if (
    [order.inputOracle, output.oracle, output.settler].some(
      (value) => value.toLowerCase() !== settler
    )
  )
    return "Atomic settlement requires the canonical same-chain oracle and settler.";
  if (output.callbackData !== "0x") return "Atomic settlement does not support callbacks.";
  if (output.context !== "0x" && !/^0xe0[0-9a-fA-F]{72}$/.test(output.context))
    return "This pricing context requires ordinary filling.";
  try {
    validateSolanaOrder(order as StandardSolana, order.user);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function solanaOrderId(order: StandardSolana): `0x${string}` {
  return new StandardSolanaIntent(pubkeyToBytes32(inputSettlerEscrowPda()), order).orderId();
}

export function compactSamechainOrder(order: StandardSolana, solver: `0x${string}`) {
  const problem = atomicFillProblem({
    order,
    inputSettler: pubkeyToBytes32(inputSettlerEscrowPda())
  } as OrderContainer);
  if (problem) throw new Error(problem);
  const output = order.outputs[0];
  const context = output.context;
  // Context starts with e0, followed by the solver and a big-endian u32.
  const exclusive = context === "0x" ? undefined : (`0x${context.slice(4, 68)}` as `0x${string}`);
  const startTime = context === "0x" ? undefined : Number.parseInt(context.slice(68), 16);
  return {
    nonce: BigInt(order.nonce),
    expires: order.expires,
    fillDeadline: order.fillDeadline,
    inputAmount: BigInt(order.inputs[0][1]),
    outputAmount: BigInt(output.amount),
    context: !exclusive
      ? { none: {} }
      : exclusive.toLowerCase() === solver.toLowerCase()
        ? { exclusiveForSelf: { startTime: startTime! } }
        : { exclusiveFor: { exclusiveFor: exclusive, startTime: startTime! } }
  };
}
