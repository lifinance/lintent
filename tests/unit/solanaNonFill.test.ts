import { describe, expect, test } from "bun:test";
import {
  borshEncodeSolanaOrder,
  encodeNotFilledDescription,
  getNotFilledDescriptionHash,
  getOutputHash
} from "@lifi/intent";
import type { MandateOutput, StandardSolana } from "@lifi/intent";
import { base64 } from "@scure/base";
import { PublicKey } from "@solana/web3.js";
import { bytesToHex, hexToBytes, sha256, toBytes } from "viem";
import {
  INPUT_SETTLER_ESCROW_PROGRAM_ID,
  INTENTS_PROTOCOL_PROGRAM_ID,
  OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
  POLYMER_PROGRAM_ID
} from "../../src/lib/idl";
import {
  ATTEST_NOT_FILLED_DISCRIMINATOR,
  CHAIN_MAPPING_DISCRIMINATOR,
  LOCAL_ATTESTATION_DISCRIMINATOR,
  REFUND_ON_NON_FILL_DISCRIMINATOR,
  SUBMIT_CONSUME_DISCRIMINATOR,
  buildAttestNotFilledInstruction,
  buildCreateAtaIdempotentInstruction,
  buildRefundOnNonFillInstruction,
  buildSubmitConsumeNotFilledInstruction,
  classifyLocalAttestation,
  encodeBorshMandateOutput,
  estimateLegacyTxSize,
  expectedNotFilledProveLog
} from "../../src/lib/solana/nonFill";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  bytes32ToPubkey,
  fillIdPda,
  localAttestationPda,
  localConsumerPda,
  orderContextPda,
  outputSettlerSimplePda,
  polymerOraclePda,
  pubkeyToBytes32
} from "../../src/lib/solana/pda";

const b32 = (nibble: string) => `0x${nibble.repeat(64)}` as `0x${string}`;
const ORDER_ID = b32("6");
const FILL_DEADLINE = 1_700_000_900;
const SIGNER = "BkEw3WHFvJR9a5deUcwPLJ79yK3r9YGdQ61TehFXzAQ";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT_B32 = "0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61" as const;

const output: MandateOutput = {
  oracle: pubkeyToBytes32(new PublicKey(POLYMER_PROGRAM_ID)),
  settler: pubkeyToBytes32(outputSettlerSimplePda()),
  chainId: 1151111081099710n,
  token: MINT_B32,
  amount: 1_000_000n,
  recipient: b32("4"),
  callbackData: "0x",
  context: "0xabcd"
} as MandateOutput;

const user = bytes32ToPubkey(b32("0")).toBase58();
const order = {
  user: pubkeyToBytes32(new PublicKey(user)),
  nonce: 1n,
  originChainId: 1151111081099710n,
  expires: 1_700_001_000,
  fillDeadline: FILL_DEADLINE,
  inputOracle: b32("8"),
  inputs: [[BigInt(MINT_B32), 1_000_000n]],
  outputs: [output]
} as unknown as StandardSolana;

const anchorDisc = (preimage: string) => hexToBytes(sha256(toBytes(preimage))).subarray(0, 8);
const notFilled = { orderId: ORDER_ID, output, fillDeadline: FILL_DEADLINE };
const localAttestation = localAttestationPda(
  outputSettlerSimplePda(),
  output.oracle,
  getNotFilledDescriptionHash(notFilled)
).toBase58();

describe("discriminators", () => {
  test.each([
    [ATTEST_NOT_FILLED_DISCRIMINATOR, "global:attest_not_filled"],
    [SUBMIT_CONSUME_DISCRIMINATOR, "global:submit_consume"],
    [REFUND_ON_NON_FILL_DISCRIMINATOR, "global:refund_on_non_fill"],
    [LOCAL_ATTESTATION_DISCRIMINATOR, "account:LocalAttestation"],
    [CHAIN_MAPPING_DISCRIMINATOR, "account:ChainMapping"]
  ])("%p is sha256(%s)[..8]", (disc, preimage) => {
    expect([...disc]).toEqual([...anchorDisc(preimage)]);
  });
});

describe("encodeBorshMandateOutput", () => {
  test("u256 BE numerics and u32LE-prefixed byte vectors", () => {
    const bytes = encodeBorshMandateOutput(output);
    expect(bytes.length).toBe(32 * 6 + 4 + 0 + 4 + 2);
    expect(bytesToHex(bytes.subarray(64, 96))).toBe(
      `0x${output.chainId.toString(16).padStart(64, "0")}`
    );
    expect([...bytes.subarray(192, 196)]).toEqual([0, 0, 0, 0]);
    expect([...bytes.subarray(196)]).toEqual([2, 0, 0, 0, 0xab, 0xcd]);
  });
});

describe("buildAttestNotFilledInstruction", () => {
  const ix = buildAttestNotFilledInstruction({ payer: SIGNER, ...notFilled });

  test("accounts in IDL order", () => {
    expect(ix.programId).toBe(OUTPUT_SETTLER_SIMPLE_PROGRAM_ID);
    expect(ix.keys.map((k) => k.pubkey)).toEqual([
      SIGNER,
      outputSettlerSimplePda().toBase58(),
      fillIdPda(ORDER_ID, getOutputHash(output)).toBase58(),
      localAttestation,
      INTENTS_PROTOCOL_PROGRAM_ID,
      SYSTEM_PROGRAM_ID
    ]);
    expect(ix.keys.map((k) => k.isWritable)).toEqual([true, false, false, true, false, false]);
    expect(ix.keys[0]!.isSigner).toBe(true);
  });

  test("data = disc ‖ orderId ‖ borsh(output) ‖ u32le(fillDeadline)", () => {
    const tail = new Uint8Array(4);
    new DataView(tail.buffer).setUint32(0, FILL_DEADLINE, true);
    expect(bytesToHex(ix.data)).toBe(
      bytesToHex(
        new Uint8Array([
          ...ATTEST_NOT_FILLED_DISCRIMINATOR,
          ...hexToBytes(ORDER_ID),
          ...encodeBorshMandateOutput(output),
          ...tail
        ])
      )
    );
  });
});

describe("buildSubmitConsumeNotFilledInstruction", () => {
  const rentRefund = bytes32ToPubkey(b32("9")).toBase58();
  const ix = buildSubmitConsumeNotFilledInstruction({ payer: SIGNER, rentRefund, ...notFilled });

  test("accounts: fixed four then the (attestation, rent_refund) pair", () => {
    expect(ix.programId).toBe(POLYMER_PROGRAM_ID);
    expect(ix.keys.map((k) => k.pubkey)).toEqual([
      SIGNER,
      polymerOraclePda().toBase58(),
      localConsumerPda(POLYMER_PROGRAM_ID).toBase58(),
      INTENTS_PROTOCOL_PROGRAM_ID,
      localAttestation,
      rentRefund
    ]);
    expect(ix.keys.map((k) => k.isWritable)).toEqual([true, false, false, false, true, true]);
  });

  test("data = disc ‖ source ‖ u32le(1) ‖ u32le(len) ‖ payload", () => {
    const payload = hexToBytes(encodeNotFilledDescription(notFilled));
    const d = ix.data;
    expect([...d.subarray(0, 8)]).toEqual([...SUBMIT_CONSUME_DISCRIMINATOR]);
    expect([...d.subarray(8, 40)]).toEqual([...outputSettlerSimplePda().toBytes()]);
    const view = new DataView(d.buffer, d.byteOffset);
    expect(view.getUint32(40, true)).toBe(1);
    expect(view.getUint32(44, true)).toBe(payload.length);
    expect(bytesToHex(d.subarray(48))).toBe(bytesToHex(payload));
  });
});

describe("buildRefundOnNonFillInstruction", () => {
  const sponsor = bytes32ToPubkey(b32("7")).toBase58();
  const attestation = bytes32ToPubkey(b32("a")).toBase58();
  const ix = buildRefundOnNonFillInstruction({
    signer: SIGNER,
    order,
    orderId: ORDER_ID,
    sponsor,
    tokenProgramId: TOKEN_PROGRAM_ID,
    outputIndex: 3,
    attestation
  });
  const orderContext = orderContextPda(ORDER_ID).toBase58();

  test("13 fixed + 2 remaining accounts at their program positions", () => {
    expect(ix.programId).toBe(INPUT_SETTLER_ESCROW_PROGRAM_ID);
    expect(ix.keys).toHaveLength(15);
    expect(ix.keys[0]).toEqual({ pubkey: SIGNER, isSigner: true, isWritable: true });
    expect(ix.keys[1]!.pubkey).toBe(user);
    expect(ix.keys[2]).toEqual({ pubkey: sponsor, isSigner: false, isWritable: true });
    expect(ix.keys[4]!.pubkey).toBe(orderContext);
    expect(ix.keys[5]!.pubkey).toBe(associatedTokenAddress(MINT, orderContext).toBase58());
    expect(ix.keys[6]!.pubkey).toBe(associatedTokenAddress(MINT, user).toBase58());
    expect(ix.keys[7]).toEqual({ pubkey: MINT, isSigner: false, isWritable: true });
    expect(ix.keys[8]!.pubkey).toBe(localConsumerPda(INPUT_SETTLER_ESCROW_PROGRAM_ID).toBase58());
    expect(ix.keys[9]!.pubkey).toBe(INTENTS_PROTOCOL_PROGRAM_ID);
    expect(ix.keys[10]!.pubkey).toBe(TOKEN_PROGRAM_ID);
    expect(ix.keys[11]!.pubkey).toBe(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(ix.keys[12]!.pubkey).toBe(SYSTEM_PROGRAM_ID);
    expect(ix.keys[13]).toEqual({ pubkey: attestation, isSigner: false, isWritable: false });
    expect(ix.keys[14]).toEqual({ pubkey: SIGNER, isSigner: false, isWritable: false });
  });

  test("data = disc ‖ borsh(order) ‖ u8(outputIndex)", () => {
    const encoded = borshEncodeSolanaOrder(order);
    expect([...ix.data.subarray(0, 8)]).toEqual([...REFUND_ON_NON_FILL_DISCRIMINATOR]);
    expect(bytesToHex(ix.data.subarray(8, 8 + encoded.length))).toBe(bytesToHex(encoded));
    expect(ix.data.length).toBe(8 + encoded.length + 1);
    expect(ix.data[ix.data.length - 1]).toBe(3);
  });

  test("rejects an output index outside u8", () => {
    expect(() =>
      buildRefundOnNonFillInstruction({
        signer: SIGNER,
        order,
        orderId: ORDER_ID,
        sponsor,
        tokenProgramId: TOKEN_PROGRAM_ID,
        outputIndex: 256,
        attestation
      })
    ).toThrow("u8");
  });
});

describe("buildCreateAtaIdempotentInstruction", () => {
  test("CreateIdempotent layout", () => {
    const ix = buildCreateAtaIdempotentInstruction({
      payer: SIGNER,
      owner: user,
      mint: MINT,
      tokenProgramId: TOKEN_PROGRAM_ID
    });
    expect(ix.programId).toBe(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(ix.keys.map((k) => k.pubkey)).toEqual([
      SIGNER,
      associatedTokenAddress(MINT, user).toBase58(),
      user,
      MINT,
      SYSTEM_PROGRAM_ID,
      TOKEN_PROGRAM_ID
    ]);
    expect([...ix.data]).toEqual([1]);
  });
});

describe("expectedNotFilledProveLog", () => {
  test("base64 of settler PDA ‖ not-filled payload", () => {
    const bytes = new Uint8Array([
      ...outputSettlerSimplePda().toBytes(),
      ...hexToBytes(encodeNotFilledDescription(notFilled))
    ]);
    expect(expectedNotFilledProveLog(notFilled)).toBe(
      `Program log: Prove: program: ${POLYMER_PROGRAM_ID}, ${base64.encode(bytes)}`
    );
  });
});

describe("classifyNotFilledLocalAttestation", () => {
  const rentRefund = bytes32ToPubkey(b32("9"));
  function account(
    opts: {
      length?: number;
      consumed?: number;
      deadline?: number;
      disc?: Uint8Array;
      owner?: string;
      zeroRefund?: boolean;
    } = {}
  ) {
    const data = new Uint8Array(opts.length ?? 46);
    data.set(opts.disc ?? LOCAL_ATTESTATION_DISCRIMINATOR, 0);
    new DataView(data.buffer).setUint32(8, opts.deadline ?? FILL_DEADLINE, true);
    if (data.length === 46) {
      if (!opts.zeroRefund) data.set(rentRefund.toBytes(), 13);
      data[45] = opts.consumed ?? 0;
    }
    return { owner: opts.owner ?? INTENTS_PROTOCOL_PROGRAM_ID, lamports: 1, data };
  }

  test("absent for null or an empty system account", () => {
    expect(classifyLocalAttestation(null, FILL_DEADLINE)).toEqual({ kind: "absent" });
    expect(
      classifyLocalAttestation(
        { owner: SYSTEM_PROGRAM_ID, lamports: 5, data: new Uint8Array() },
        FILL_DEADLINE
      )
    ).toEqual({ kind: "absent" });
  });

  test("current carries the stored rent payer", () => {
    expect(classifyLocalAttestation(account(), FILL_DEADLINE)).toEqual({
      kind: "current",
      rentRefund: rentRefund.toBase58()
    });
  });

  test("consumed and legacy", () => {
    expect(classifyLocalAttestation(account({ consumed: 1 }), FILL_DEADLINE)).toEqual({
      kind: "consumed"
    });
    expect(classifyLocalAttestation(account({ length: 13 }), FILL_DEADLINE)).toEqual({
      kind: "legacy"
    });
  });

  test.each([
    ["wrong owner", { owner: SYSTEM_PROGRAM_ID }],
    ["wrong length", { length: 40 }],
    ["wrong discriminator", { disc: CHAIN_MAPPING_DISCRIMINATOR }],
    ["wrong fill deadline", { deadline: FILL_DEADLINE + 1 }],
    ["zero rent refund", { zeroRefund: true }],
    ["invalid consumed flag", { consumed: 2 }]
  ])("throws on %s", (_label, opts) => {
    expect(() => classifyLocalAttestation(account(opts), FILL_DEADLINE)).toThrow();
  });
});

describe("estimateLegacyTxSize", () => {
  test("one-signer size = message + 1 + 64, and grows with instructions", async () => {
    const ata = buildCreateAtaIdempotentInstruction({
      payer: SIGNER,
      owner: user,
      mint: MINT,
      tokenProgramId: TOKEN_PROGRAM_ID
    });
    const small = await estimateLegacyTxSize([ata], SIGNER);
    const refund = buildRefundOnNonFillInstruction({
      signer: SIGNER,
      order,
      orderId: ORDER_ID,
      sponsor: SIGNER,
      tokenProgramId: TOKEN_PROGRAM_ID,
      outputIndex: 0,
      attestation: localAttestation
    });
    const both = await estimateLegacyTxSize([ata, refund], SIGNER);
    expect(both).toBeGreaterThan(small + refund.data.length);
    expect(both).toBeLessThan(1232);
  });
});
