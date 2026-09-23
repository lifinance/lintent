import { PublicKey } from "@solana/web3.js";
import inputIdl from "../../../src/lib/idl/input_settler_escrow.json";
import outputIdl from "../../../src/lib/idl/output_settler_simple.json";
import protocolIdl from "../../../src/lib/idl/intents_protocol.json";

export function clockData(timestamp = 1_700_000_000) {
  const data = new Uint8Array(40);
  new DataView(data.buffer).setBigInt64(32, BigInt(timestamp), true);
  return data;
}

export function contextData(inputToken: string, user: string, sponsor = user) {
  const data = new Uint8Array(105);
  data.set(inputIdl.accounts.find((a) => a.name === "OrderContext")!.discriminator);
  data.set(new PublicKey(inputToken).toBytes(), 8);
  data.set(new PublicKey(user).toBytes(), 40);
  data.set(new PublicKey(sponsor).toBytes(), 72);
  return data;
}

export function localAttestationData(
  rentRefund: string,
  timestamp = 1_700_000_000,
  consumed = false
) {
  const data = new Uint8Array(46);
  data.set(protocolIdl.accounts.find((a) => a.name === "LocalAttestation")!.discriminator);
  new DataView(data.buffer).setUint32(8, timestamp, true);
  data[12] = 255;
  data.set(new PublicKey(rentRefund).toBytes(), 13);
  data[45] = Number(consumed);
  return data;
}

export function fillRecordData(rentRefund: string, closeAfter = 1_700_173_700n) {
  const data = new Uint8Array(48);
  data.set(outputIdl.accounts.find((a) => a.name === "FillRecord")!.discriminator);
  data.set(new PublicKey(rentRefund).toBytes(), 8);
  new DataView(data.buffer).setBigUint64(40, closeAfter, true);
  return data;
}
