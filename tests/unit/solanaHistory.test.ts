import { describe, test, expect } from "bun:test";
import { SOLANA_DEVNET_CHAIN_ID, type StandardSolana } from "@lifi/intent";
import { PublicKey } from "@solana/web3.js";
import { pubkeyToBytes32, outputSettlerSimplePda } from "../../src/lib/solana/pda";
import { solanaOrderId } from "../../src/lib/solana/order";
import {
  successfulSolanaTransaction,
  verifiedAtomicSettlement,
  verifiedFill,
  verifiedFinalisation
} from "../../src/lib/solana/history";
import { fillReceipt, settlementLogs } from "../fixtures/solana/transactions";
import {
  INPUT_SETTLER_ESCROW_PROGRAM_ID,
  OUTPUT_SETTLER_SIMPLE_PROGRAM_ID
} from "../../src/lib/idl";

const bytes = (n: number) => pubkeyToBytes32(new PublicKey(new Uint8Array(32).fill(n)));
const settler = pubkeyToBytes32(outputSettlerSimplePda());
const order: StandardSolana = {
  user: bytes(1),
  nonce: 3n,
  originChainId: SOLANA_DEVNET_CHAIN_ID,
  expires: 1_800_001_200,
  fillDeadline: 1_800_000_600,
  inputOracle: settler,
  inputs: [[BigInt(bytes(2)), 100n]],
  outputs: [
    {
      oracle: settler,
      settler,
      chainId: SOLANA_DEVNET_CHAIN_ID,
      token: bytes(2),
      amount: 90n,
      recipient: bytes(4),
      callbackData: "0x",
      context: "0x"
    }
  ]
};
const id = solanaOrderId(order);

describe("Solana settlement evidence", () => {
  test("a JSON-persisted receipt establishes completion without live proof accounts", () => {
    const receipt = JSON.parse(JSON.stringify(fillReceipt(order, bytes(3), 1_800_000_000)));
    expect(verifiedAtomicSettlement(receipt, id, order.outputs[0])).toBe(true);
    expect(verifiedFill(receipt, id, order.outputs[0]).solver).toBe(bytes(3));
    expect(verifiedFinalisation(receipt, id)?.destination).toBe(bytes(3));
  });

  test("ordinary fills remain filled but require a separate finalisation receipt", () => {
    const receipt = fillReceipt(order, bytes(3), 1_800_000_000, false);
    expect(verifiedAtomicSettlement(receipt, id, order.outputs[0])).toBe(false);
    expect(verifiedFill(receipt, id, order.outputs[0]).orderId).toBe(id);
    receipt.meta!.logMessages = settlementLogs(order, bytes(3));
    expect(verifiedFinalisation(receipt, id)).toBeDefined();
  });

  test("rejects failed, missing, forged, duplicated, and mismatched evidence", () => {
    const tx = fillReceipt(order, bytes(3), 1_800_000_000);
    expect(successfulSolanaTransaction(null)).toBe(false);
    expect(
      successfulSolanaTransaction({
        ...tx,
        meta: { err: { InstructionError: [1, "Custom"] }, logMessages: tx.meta!.logMessages }
      })
    ).toBe(false);
    expect(verifiedAtomicSettlement({ ...tx, meta: null }, id, order.outputs[0])).toBe(false);
    const forged = {
      ...tx,
      meta: {
        err: null,
        logMessages: tx.meta!.logMessages!.map((log) =>
          log.replaceAll(INPUT_SETTLER_ESCROW_PROGRAM_ID, OUTPUT_SETTLER_SIMPLE_PROGRAM_ID)
        )
      }
    };
    expect(verifiedAtomicSettlement(forged, id, order.outputs[0])).toBe(false);
    const duplicate = {
      ...tx,
      meta: {
        err: null,
        logMessages: [...tx.meta!.logMessages!, ...settlementLogs(order, bytes(3))]
      }
    };
    expect(() => verifiedAtomicSettlement(duplicate, id, order.outputs[0])).toThrow("Ambiguous");
    expect(verifiedAtomicSettlement(tx, bytes(9), order.outputs[0])).toBe(false);
    expect(() => verifiedAtomicSettlement(tx, id, { ...order.outputs[0], amount: 89n })).toThrow(
      "No matching"
    );
    const mismatch = fillReceipt(order, bytes(3), 1_800_000_000, false);
    mismatch.meta!.logMessages!.unshift(...settlementLogs(order, bytes(9)));
    expect(() => verifiedAtomicSettlement(mismatch, id, order.outputs[0])).toThrow(
      "solver do not match"
    );
  });

  test("self-fill events describe nominal delivery, without assuming a balance increase", () => {
    const tx = fillReceipt(order, order.outputs[0].recipient, 1_800_000_000);
    expect(verifiedAtomicSettlement(tx, id, order.outputs[0])).toBe(true);
    expect(verifiedFill(tx, id, order.outputs[0]).finalAmount).toBe(90n);
  });
});
