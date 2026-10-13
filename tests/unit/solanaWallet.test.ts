import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SOLANA_DEVNET_CHAIN_ID } from "@lifi/intent";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import { SOLANA_GENESIS_HASHES, invalidateSolanaClusterGuard } from "../../src/lib/solana/client";
import { createSolanaSigner } from "../../src/lib/solana/wallet";
import type { SolanaSigningWallet } from "../../src/lib/solana/wallet";
import type { SolanaConnectionLike, SolanaInstructionLike } from "../../src/lib/solana/types";

const chainId = SOLANA_DEVNET_CHAIN_ID;
const payer = Keypair.fromSeed(new Uint8Array(32).fill(1));
const additional = Keypair.fromSeed(new Uint8Array(32).fill(2));
const program = new PublicKey(new Uint8Array(32).fill(3));
const blockhash = new PublicKey(new Uint8Array(32).fill(4)).toBase58();
let actions: string[];
let broadcast: Uint8Array[];
let genesis: string;
let readError: unknown;
let replaceMessage: boolean;
let dropLocalSignature: boolean;
let prepared: Transaction | undefined;
let restorers: { mockRestore(): void }[];

const reads: SolanaConnectionLike = {
  rpcEndpoint: "https://wallet-tests.invalid",
  getGenesisHash: async () => genesis,
  getAccountInfo: async () => null,
  getMultipleAccountsInfo: async (addresses) => addresses.map(() => null),
  getTransaction: async () => {
    actions.push("readback");
    return { slot: 1, meta: { err: readError, logMessages: [] } };
  },
  getBalance: async () => 0n,
  getTokenAccountBalance: async () => 0n,
  getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
  getSignaturesForAddress: async () => [],
  getFinalizedBlockTime: async () => 1
};
const wallet: SolanaSigningWallet = {
  publicKey: payer.publicKey.toBase58(),
  async signTransaction<T>(value: T): Promise<T> {
    actions.push("wallet");
    const transaction = value as Transaction;
    prepared = transaction;
    const signed = dropLocalSignature
      ? Transaction.from(transaction.serialize({ requireAllSignatures: false }))
      : transaction;
    if (dropLocalSignature) {
      for (const entry of signed.signatures) entry.signature = null;
    }
    if (replaceMessage) signed.recentBlockhash = PublicKey.default.toBase58();
    signed.partialSign(payer);
    return signed as T;
  }
};

function instruction(dataLength = 0): SolanaInstructionLike {
  return {
    programId: program.toBase58(),
    keys: [{ pubkey: additional.publicKey.toBase58(), isSigner: true, isWritable: true }],
    data: new Uint8Array(dataLength)
  };
}

function instructionAtSize(size: number, computeUnitLimit?: number): SolanaInstructionLike {
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
  if (computeUnitLimit)
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  const ix = instruction(128);
  tx.add(
    new TransactionInstruction({
      programId: program,
      keys: ix.keys.map((key) => ({ ...key, pubkey: new PublicKey(key.pubkey) })),
      data: Buffer.from(ix.data)
    })
  );
  const message = tx.serializeMessage();
  const actualSize = 1 + tx.signatures.length * 64 + message.length;
  // Stay in the two-byte compact length range, accounting for compute
  // instructions and the actual required signatures rather than guessing.
  return instruction(128 + size - actualSize);
}

beforeEach(() => {
  invalidateSolanaClusterGuard();
  actions = [];
  broadcast = [];
  genesis = SOLANA_GENESIS_HASHES[chainId.toString()]!;
  readError = null;
  replaceMessage = false;
  dropLocalSignature = false;
  prepared = undefined;
  restorers = [
    spyOn(Connection.prototype, "getLatestBlockhash").mockImplementation(async () => {
      actions.push("blockhash");
      return { blockhash, lastValidBlockHeight: 100 };
    }),
    spyOn(Connection.prototype, "sendRawTransaction").mockImplementation(async (raw) => {
      actions.push("send");
      broadcast.push(new Uint8Array(raw));
      return "confirmed-signature";
    }),
    spyOn(Connection.prototype, "confirmTransaction").mockImplementation(async () => {
      actions.push("confirm");
      return { context: { slot: 1 }, value: { err: null } };
    })
  ];
});
afterEach(() => {
  for (const restorer of restorers) restorer.mockRestore();
});

describe("Solana wallet signing", () => {
  test("retains the local signature when a wallet returns only its own signature", async () => {
    dropLocalSignature = true;
    const signer = createSolanaSigner(chainId, reads, wallet);
    await signer.signAndSend([instruction()], {
      additionalSigners: [additional],
      beforeSign: async () => {
        actions.push("guard");
      }
    });
    expect(actions).toEqual(["blockhash", "guard", "wallet", "send", "confirm", "readback"]);
    expect(prepared!.feePayer!.equals(payer.publicKey)).toBe(true);
    expect(prepared!.recentBlockhash).toBe(blockhash);
    expect(
      prepared!.signatures.find((entry) => entry.publicKey.equals(additional.publicKey))!.signature
    ).not.toBeNull();
    const sent = Transaction.from(Buffer.from(broadcast[0]!));
    expect(sent.signatures).toHaveLength(2);
    expect(sent.verifySignatures()).toBe(true);
  });

  test.each([undefined, 1_000_000])(
    "accepts exactly 1232 bytes including all signatures and compute instructions (%s)",
    async (computeUnitLimit) => {
      const signer = createSolanaSigner(chainId, reads, wallet);
      await signer.signAndSend([instructionAtSize(1232, computeUnitLimit)], {
        computeUnitLimit,
        additionalSigners: [additional]
      });
      expect(broadcast[0]!.length).toBe(1232);
      expect(Transaction.from(Buffer.from(broadcast[0]!)).verifySignatures()).toBe(true);
    }
  );

  test.each([undefined, 1_000_000])(
    "rejects 1233 bytes before guard or wallet (%s)",
    async (computeUnitLimit) => {
      const signer = createSolanaSigner(chainId, reads, wallet);
      await expect(
        signer.signAndSend([instructionAtSize(1233, computeUnitLimit)], {
          computeUnitLimit,
          additionalSigners: [additional],
          beforeSign: async () => {
            actions.push("guard");
          }
        })
      ).rejects.toThrow("1233 bytes");
      expect(actions).toEqual(["blockhash"]);
      expect(broadcast).toHaveLength(0);
    }
  );

  test("a fresh guard failure after preparation prevents wallet signing and broadcast", async () => {
    await expect(
      createSolanaSigner(chainId, reads, wallet).signAndSend([instruction()], {
        additionalSigners: [additional],
        beforeSign: async () => {
          actions.push("guard");
          throw new Error("No longer refundable");
        }
      })
    ).rejects.toThrow("No longer refundable");
    expect(actions).toEqual(["blockhash", "guard"]);
    expect(broadcast).toHaveLength(0);
  });

  test("rejects wallet message changes rather than attach local signatures to different instructions", async () => {
    replaceMessage = true;
    await expect(
      createSolanaSigner(chainId, reads, wallet).signAndSend([instruction()], {
        additionalSigners: [additional]
      })
    ).rejects.toThrow("changed the prepared transaction");
    expect(broadcast).toHaveLength(0);
  });

  test("a wrong cluster blocks preparation and wallet signing", async () => {
    genesis = "wrong-cluster";
    await expect(
      createSolanaSigner(chainId, reads, wallet).signAndSend([instruction()], {
        additionalSigners: [additional]
      })
    ).rejects.toThrow();
    expect(actions).toHaveLength(0);
    expect(broadcast).toHaveLength(0);
  });

  test("confirmed transactions with failed readback are not reported successful", async () => {
    readError = { InstructionError: [0, "InvalidArgument"] };
    await expect(
      createSolanaSigner(chainId, reads, wallet).signAndSend([instruction()], {
        additionalSigners: [additional]
      })
    ).rejects.toThrow("reverted");
    expect(actions).toContain("readback");
  });
});
