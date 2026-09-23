import { BorshCoder, BN, type Idl } from "@coral-xyz/anchor";
import type { StandardSolana } from "@lifi/intent";
import { hexToBytes, numberToHex } from "viem";
import inputIdl from "../../../src/lib/idl/input_settler_escrow.json";
import outputIdl from "../../../src/lib/idl/output_settler_simple.json";
import { orderContextPda, bytes32ToPubkey } from "../../../src/lib/solana/pda";
import { solanaOrderId } from "../../../src/lib/solana/order";
import type { SolanaTransactionLike } from "../../../src/lib/solana/types";

function eventLogs(idl: typeof inputIdl | typeof outputIdl, name: string, value: object) {
  const discriminator = idl.events.find((event) => event.name === name)!.discriminator;
  const body = new BorshCoder(idl as Idl).types.encode(name, value);
  const encoded = Buffer.concat([Buffer.from(discriminator), body]).toString("base64");
  return [
    `Program ${idl.address} invoke [1]`,
    `Program data: ${encoded}`,
    `Program ${idl.address} success`
  ];
}

export function settlementLogs(order: StandardSolana, solver: `0x${string}`) {
  const id = solanaOrderId(order);
  return eventLogs(inputIdl, "FinalisedEvent", {
    settler: orderContextPda(id),
    order_id: Array.from(hexToBytes(id)),
    solver: Array.from(hexToBytes(solver)),
    destination: Array.from(hexToBytes(solver))
  });
}

export function fillReceipt(
  order: StandardSolana,
  solver: `0x${string}`,
  timestamp: number,
  atomic = true
): NonNullable<SolanaTransactionLike> {
  const id = solanaOrderId(order);
  const output = order.outputs[0];
  const bytes = (value: `0x${string}`) => Array.from(hexToBytes(value));
  const logs = eventLogs(outputIdl, "OutputFilledEvent", {
    settler: bytes32ToPubkey(output.settler),
    order_id: bytes(id),
    solver: bytes(solver),
    timestamp,
    output: {
      oracle: bytes(output.oracle),
      settler: bytes(output.settler),
      chain_id: bytes(numberToHex(BigInt(output.chainId), { size: 32 })),
      token: bytes(output.token),
      amount: bytes(numberToHex(BigInt(output.amount), { size: 32 })),
      recipient: bytes(output.recipient),
      callback_data: Buffer.from(hexToBytes(output.callbackData)),
      context: Buffer.from(hexToBytes(output.context))
    },
    final_amount: new BN(output.amount.toString())
  });
  return {
    slot: 12345,
    blockTime: timestamp,
    meta: { err: null, logMessages: [...(atomic ? settlementLogs(order, solver) : []), ...logs] }
  };
}
