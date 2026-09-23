import { bytesToHex } from "viem";
import inputIdl from "$lib/idl/input_settler_escrow.json";
import outputIdl from "$lib/idl/output_settler_simple.json";
import protocolIdl from "$lib/idl/intents_protocol.json";
import {
  INPUT_SETTLER_ESCROW_PROGRAM_ID,
  OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
  INTENTS_PROTOCOL_PROGRAM_ID
} from "$lib/idl";
import { bytes32ToPubkey } from "./pda";
import type { SolanaAccountInfoLike } from "./types";

function accountData(
  info: SolanaAccountInfoLike,
  program: string,
  discriminator: number[],
  size: number,
  name: string
): Uint8Array {
  if (
    !info ||
    info.owner !== program ||
    info.data.length !== size ||
    !discriminator.every((b, i) => info.data[i] === b)
  ) {
    throw new Error(
      `Invalid ${name} account; this cluster or account may require the Solana contract upgrade.`
    );
  }
  return info.data;
}

const keyAt = (data: Uint8Array, offset: number) =>
  bytes32ToPubkey(bytesToHex(data.slice(offset, offset + 32))).toBase58();

export function decodeOrderContext(info: SolanaAccountInfoLike) {
  const data = accountData(
    info,
    INPUT_SETTLER_ESCROW_PROGRAM_ID,
    inputIdl.accounts.find((a) => a.name === "OrderContext")!.discriminator,
    105,
    "OrderContext"
  );
  return { inputToken: keyAt(data, 8), user: keyAt(data, 40), sponsor: keyAt(data, 72) };
}

export function decodeFillRecord(info: SolanaAccountInfoLike) {
  const data = accountData(
    info,
    OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
    outputIdl.accounts.find((a) => a.name === "FillRecord")!.discriminator,
    48,
    "FillRecord"
  );
  return {
    rentRefund: keyAt(data, 8),
    closeAfter: new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(40, true),
    lamports: info!.lamports
  };
}

export function decodeLocalAttestation(info: SolanaAccountInfoLike) {
  const data = accountData(
    info,
    INTENTS_PROTOCOL_PROGRAM_ID,
    protocolIdl.accounts.find((a) => a.name === "LocalAttestation")!.discriminator,
    46,
    "LocalAttestation"
  );
  if (data[45] > 1) throw new Error("Invalid attestation consumed flag");
  return {
    timestamp: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(8, true),
    bump: data[12],
    rentRefund: keyAt(data, 13),
    consumed: data[45] === 1
  };
}
