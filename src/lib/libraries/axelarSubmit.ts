import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { addressToBytes32, bytes32ToAddress, bytes32ToStellarContract } from "@lifi/intent";
import { encodeFunctionData, hexToBytes } from "viem";
import { AXELAR_ORACLE_ABI, LEGACY_AXELAR_ORACLE_ABI } from "$lib/abi/axelaroracle";
import { assertRelayPayloads } from "./fillGuards";
import {
  AXELAR_CHAIN_NAMES,
  BYTES32_ZERO,
  axelarCorridor,
  isStellarChain,
  type AxelarGeneration
} from "$lib/config";

/** Where an Axelar proof goes: the order's input chain and its oracle. */
export type AxelarSubmitRoute = {
  generation: AxelarGeneration;
  destinationChainId: bigint;
  destinationName: string;
  destinationIsStellar: boolean;
  /** Raw 32-byte id: Stellar contract id or left-padded EVM address. */
  recipientOracle: `0x${string}`;
};

export function axelarSubmitRoute(
  sourceChainId: number | bigint,
  destinationChainId: number | bigint,
  recipientOracle: `0x${string}`
): AxelarSubmitRoute {
  const { network } = axelarCorridor(sourceChainId, destinationChainId);
  return {
    generation: network.generation,
    destinationChainId: BigInt(destinationChainId),
    destinationName: AXELAR_CHAIN_NAMES[Number(destinationChainId)]!,
    destinationIsStellar: isStellarChain(destinationChainId),
    recipientOracle: addressToBytes32(recipientOracle)
  };
}

/** Legacy oracles encode the raw id by route kind; EVM ids need 12 leading zero bytes. */
function legacyRecipient(route: AxelarSubmitRoute) {
  if (!route.destinationIsStellar && BigInt(route.recipientOracle) >> 160n !== 0n)
    throw new Error("EVM recipient oracle must be a left-padded 20-byte address");
  return route.recipientOracle;
}
/** Current oracles forward the native recipient string to the gateway unchanged. */
function currentRecipient(route: AxelarSubmitRoute) {
  return route.destinationIsStellar
    ? bytes32ToStellarContract(route.recipientOracle)
    : bytes32ToAddress(route.recipientOracle);
}

/** EVM AxelarOracle `submit` calldata: paid Relayed mode, zero destination config. */
export function evmAxelarSubmitData(
  route: AxelarSubmitRoute,
  source: `0x${string}`,
  payloads: `0x${string}`[]
) {
  assertRelayPayloads(payloads);
  return route.generation === "legacy"
    ? encodeFunctionData({
        abi: LEGACY_AXELAR_ORACLE_ABI,
        functionName: "submit",
        args: [route.destinationName, legacyRecipient(route), source, payloads, BYTES32_ZERO, 0]
      })
    : encodeFunctionData({
        abi: AXELAR_ORACLE_ABI,
        functionName: "submit",
        args: [route.destinationName, currentRecipient(route), source, payloads, BYTES32_ZERO, 0]
      });
}

const scBytes = (hex: `0x${string}`) => nativeToScVal(hexToBytes(hex));

/** Stellar AxelarOracle `submit` arguments: paid Relayed mode, zero destination config. */
export function stellarAxelarSubmitArgs(
  route: AxelarSubmitRoute,
  opts: { source: string; payer: string; payloads: `0x${string}`[]; gasAmount: bigint }
): xdr.ScVal[] {
  assertRelayPayloads(opts.payloads);
  const destination =
    route.generation === "legacy"
      ? [nativeToScVal(route.destinationName, { type: "string" }), scBytes(legacyRecipient(route))]
      : [
          nativeToScVal(route.destinationChainId, { type: "u256" }),
          nativeToScVal(currentRecipient(route), { type: "string" })
        ];
  return [
    ...destination,
    new Address(opts.source).toScVal(),
    xdr.ScVal.scvVec(opts.payloads.map(scBytes)),
    new Address(opts.payer).toScVal(),
    nativeToScVal(opts.gasAmount, { type: "i128" }),
    scBytes(BYTES32_ZERO),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Relayed")])
  ];
}
