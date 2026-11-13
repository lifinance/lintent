import type { MandateOutput } from "@lifi/intent";
import { AXELAR_ORACLE } from "$lib/config";
import { isBytes32ForChainType } from "$lib/utils/address";
import { isSolanaChain } from "$lib/utils/chainType";

/**
 * `encodeFillDescription` is 168 fixed bytes plus `callbackData` and `context`.
 * A body past this limit encodes to more than a uint16, so a relay that
 * prefixes the payload with a uint16 length cannot carry it. The contracts
 * leave the check to the solver.
 */
export const MAX_FILL_DESCRIPTION_BODY = 65_535 - 168;

/** The encoded fill description itself must fit in a uint16 length prefix. */
export const MAX_RELAY_PAYLOAD_BYTES = 65_535;

const EVEN_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

function hexByteLength(value: `0x${string}`, label: string): number {
  if (!EVEN_HEX.test(value)) throw new Error(`${label} is not even-length hex`);
  return (value.length - 2) / 2;
}

export function fillDescriptionBodyLength(
  output: Pick<MandateOutput, "callbackData" | "context">
): number {
  return (
    hexByteLength(output.callbackData, "Callback data") + hexByteLength(output.context, "Context")
  );
}

/** Reject a fill whose proof cannot be relayed. Same-chain attestation is exempt. */
export function assertRelayableFillDescription(
  output: Pick<MandateOutput, "callbackData" | "context">
): void {
  const body = fillDescriptionBodyLength(output);
  if (body > MAX_FILL_DESCRIPTION_BODY) {
    throw new Error(
      `Callback data and context are ${body} bytes together. They must stay within ${MAX_FILL_DESCRIPTION_BODY} bytes or the fill proof cannot be relayed.`
    );
  }
}

export function assertRelayPayloads(payloads: readonly `0x${string}`[]): void {
  for (const payload of payloads) {
    const length = hexByteLength(payload, "Relay payload");
    if (length > MAX_RELAY_PAYLOAD_BYTES) {
      throw new Error(
        `Fill proof is ${length} bytes. A relayed proof must fit in ${MAX_RELAY_PAYLOAD_BYTES} bytes.`
      );
    }
  }
}

/**
 * An EVM or Tron filler id is a 20-byte address in the low bytes. High bits
 * make a different identifier than the account the input settler will pay.
 * Solana pubkeys and Stellar commitments are full 32-byte values and must
 * not be passed here.
 */
export function assertCleanAccountFiller(solverBytes32: `0x${string}`): void {
  if (!isBytes32ForChainType(solverBytes32, "evm")) {
    throw new Error("EVM and Tron filler data must be a left-padded 20-byte address.");
  }
}

/** Axelar submit, and a Solana output proved to another chain, relay the fill description. */
export function relaysFillDescription(
  order: { inputOracle: `0x${string}`; originChainId?: bigint },
  outputChainId: bigint
): boolean {
  const oracle = order.inputOracle.toLowerCase();
  for (const candidate of Object.values(AXELAR_ORACLE)) {
    if (candidate && candidate.toLowerCase() === oracle) return true;
  }
  if (!isSolanaChain(outputChainId)) return false;
  if (order.originChainId !== undefined && BigInt(order.originChainId) === outputChainId) {
    return false;
  }
  return true;
}
