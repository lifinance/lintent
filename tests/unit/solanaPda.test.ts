import { describe, expect, test } from "bun:test";
import {
  SOLANA_CHAIN_ID_PDA,
  SOLANA_INPUT_SETTLER_ESCROW_PDA,
  SOLANA_OUTPUT_SETTLER_PDA,
  SOLANA_POLYMER_ORACLE_PDA
} from "@lifi/intent";
import {
  INPUT_SETTLER_ESCROW_PROGRAM_ID,
  INTENTS_PROTOCOL_PROGRAM_ID,
  OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
  POLYMER_PROGRAM_ID
} from "../../src/lib/idl";
import {
  POLYMER_PROVER_PROGRAM_ID,
  bytes32ToPubkey,
  chainIdPda,
  consumedOrderPda,
  fillIdPda,
  inputSettlerEscrowPda,
  outputSettlerSimplePda,
  polymerOraclePda,
  orderContextPda,
  polymerScratchPdas,
  pubkeyToBytes32,
  u128ToLeBytes
} from "../../src/lib/solana/pda";

const ORDER_ID = `0x${"11".repeat(32)}` as const;
const OUTPUT_HASH = `0x${"22".repeat(32)}` as const;

describe("solana program ids", () => {
  test("come from the IDLs' top-level address field", () => {
    // Anchor >= 0.30 moved the program id out of `metadata`. Reading
    // `metadata.address` yields undefined and silently derives every PDA under
    // a garbage program id, so pin the values here.
    expect(INTENTS_PROTOCOL_PROGRAM_ID).toBe("LiFixdGLT5CMdLsHBvaijTXpPy4Uux9Y53SXkuR4HaK");
    expect(INPUT_SETTLER_ESCROW_PROGRAM_ID).toBe("LiFiRp8RM7nJUZyUYC9FPPpDr7sAy5XPfBN6ABzBgT7");
    expect(OUTPUT_SETTLER_SIMPLE_PROGRAM_ID).toBe("LiFiEDFjz5x1jJe9gSXNDHQW4dWt4yLXdp2VN4EiQUt");
    expect(POLYMER_PROGRAM_ID).toBe("LiFiBtfyPT1DnTHTAeZ2rwr5RgMrThwA5kt7KGT5nBV");
  });
});

describe("static PDAs", () => {
  // Golden vectors: these four accounts are initialised on chain, so a change
  // here means the app would read and write the wrong accounts entirely.
  test.each([
    ["chain_id", chainIdPda(), "BkEw3WHFvJR9a5deUcwPLJ79yK3r9YGdQ61TehFXzAQ", SOLANA_CHAIN_ID_PDA],
    [
      "input_settler_escrow",
      inputSettlerEscrowPda(),
      "Cj3mSoPJtgi5bubC9rLz8oM1DuXoJj97RMw1uC6ev9zm",
      SOLANA_INPUT_SETTLER_ESCROW_PDA
    ],
    [
      "output_settler_simple",
      outputSettlerSimplePda(),
      "DHShHmVkTwCzUzAQbCu4GDqJmursuDscNR6o4hTBgeRy",
      SOLANA_OUTPUT_SETTLER_PDA
    ],
    [
      "polymer",
      polymerOraclePda(),
      "49zLKETMq34CUC2E2wL1xvv6uN2AUgyhjVX221mjE3Rw",
      SOLANA_POLYMER_ORACLE_PDA
    ]
  ])("%s derives to the deployed account", (_seed, pda, base58, bytes32) => {
    expect(pda.toBase58()).toBe(base58);
    // The app-side derivation and the library constant must agree; they are
    // independent code paths that both feed order construction.
    expect(pubkeyToBytes32(pda)).toBe(bytes32);
  });
});

describe("order-scoped PDAs", () => {
  test("order_context and consumed_order are distinct for the same order", () => {
    // Different seed prefixes, same order id — conflating them would make
    // `open` collide with its own replay guard.
    expect(orderContextPda(ORDER_ID).toBase58()).not.toBe(consumedOrderPda(ORDER_ID).toBase58());
  });

  test("order-scoped PDAs vary with the order id", () => {
    const other = `0x${"33".repeat(32)}` as const;
    expect(orderContextPda(ORDER_ID).toBase58()).not.toBe(orderContextPda(other).toBase58());
    expect(consumedOrderPda(ORDER_ID).toBase58()).not.toBe(consumedOrderPda(other).toBase58());
  });

  test("fill_id varies with both of its seeds", () => {
    // fill_id = [orderId, mandateOutputHash] with NO string prefix.
    const base = fillIdPda(ORDER_ID, OUTPUT_HASH).toBase58();
    expect(fillIdPda(`0x${"33".repeat(32)}`, OUTPUT_HASH).toBase58()).not.toBe(base);
    expect(fillIdPda(ORDER_ID, `0x${"44".repeat(32)}`).toBase58()).not.toBe(base);
  });

  test("fill_id is not order_context under a different prefix", () => {
    expect(fillIdPda(ORDER_ID, OUTPUT_HASH).toBase58()).not.toBe(
      orderContextPda(ORDER_ID).toBase58()
    );
  });
});

describe("encoding helpers", () => {
  test("u128ToLeBytes is 16 bytes, little-endian", () => {
    // The attestation seed uses chain_id as u128 LE; big-endian here would
    // derive an attestation account that never exists.
    expect(u128ToLeBytes(1n)).toEqual(
      new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    );
    expect(u128ToLeBytes(1151111081099710n)).toHaveLength(16);
    expect(u128ToLeBytes(0n)).toEqual(new Uint8Array(16));
  });

  test("u128ToLeBytes accepts the decimal strings a DB round-trip produces", () => {
    // Containers rehydrated with a plain JSON.parse carry chain ids as decimal
    // strings despite the bigint type; the unguarded version threw "Cannot mix
    // BigInt and other types" from every attestationPda derivation.
    expect(u128ToLeBytes("1151111081099710" as unknown as bigint)).toEqual(
      u128ToLeBytes(1151111081099710n)
    );
    expect(() => u128ToLeBytes("not a number" as unknown as bigint)).toThrow();
  });

  test("pubkeyToBytes32 and bytes32ToPubkey round-trip", () => {
    const pda = polymerOraclePda();
    expect(bytes32ToPubkey(pubkeyToBytes32(pda)).toBase58()).toBe(pda.toBase58());
  });
});

describe("polymer prover", () => {
  test("pins the program id read from both clusters", () => {
    // Read from OraclePolymer.polymer_prover_id on mainnet AND devnet
    // (identical). readPolymerProverId re-checks this against the account, so
    // a rotation on Polymer's side fails loudly instead of as a CPI error.
    expect(POLYMER_PROVER_PROGRAM_ID).toBe("CdvSq48QUukYuMczgZAVNZrwcHNshBdtqrjW26sQiGPs");
  });

  test("derives the singleton internal PDA that exists on chain", () => {
    // This exact address exists on mainnet and devnet owned by the prover
    // program — which is what confirms the seed scheme for cache/result too,
    // since those are per-authority and only exist mid-proof.
    const { internal } = polymerScratchPdas("BkEw3WHFvJR9a5deUcwPLJ79yK3r9YGdQ61TehFXzAQ");
    expect(internal).toBe("4w6Lac3Yc8ZdJ7H4Nt9FS98VMt8w6DwkGRJL1h4Ww5z1");
  });

  test("cache and result are per-authority, internal is not", () => {
    // Two solvers proving at once must not share scratch accounts.
    const a = polymerScratchPdas("BkEw3WHFvJR9a5deUcwPLJ79yK3r9YGdQ61TehFXzAQ");
    const b = polymerScratchPdas("49zLKETMq34CUC2E2wL1xvv6uN2AUgyhjVX221mjE3Rw");
    expect(a.cache).not.toBe(b.cache);
    expect(a.result).not.toBe(b.result);
    expect(a.internal).toBe(b.internal);
    expect(a.cache).not.toBe(a.result);
  });
});
