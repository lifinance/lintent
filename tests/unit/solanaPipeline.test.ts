import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  AnchorProvider,
  BorshAccountsCoder,
  BorshInstructionCoder,
  Program,
  type Idl
} from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram
} from "@solana/web3.js";
import {
  SOLANA_DEVNET_CHAIN_ID,
  getOutputHash,
  type OrderContainer,
  type StandardSolana
} from "@lifi/intent";
import { encodePacked } from "viem";
import * as ids from "../../src/lib/idl";
import outputIdl from "../../src/lib/idl/output_settler_simple.json";
import protocolIdl from "../../src/lib/idl/intents_protocol.json";
import provenance from "../../src/lib/idl/provenance.json";
import { adaptProgram } from "../../src/lib/solana/program";
import {
  atomicFillProblem,
  compactSamechainOrder,
  solanaOrderId,
  validateSolanaOrder
} from "../../src/lib/solana/order";
import { decodeFillRecord, decodeLocalAttestation } from "../../src/lib/solana/accounts";
import {
  fillAndSettle,
  finalise,
  closeFillRecord,
  openEscrow,
  fillOutput,
  submitFillProof
} from "../../src/lib/solana/writes";
import { localAttestationDataHash } from "../../src/lib/solana/encode";
import { CLOCK_SYSVAR, readIsLocallyAttested } from "../../src/lib/solana/reads";
import { SOLANA_GENESIS_HASHES, invalidateSolanaClusterGuard } from "../../src/lib/solana/client";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  inputSettlerEscrowPda,
  outputSettlerSimplePda,
  orderContextPda,
  fillIdPda,
  localAttestationPda,
  localConsumerPda,
  pubkeyToBytes32
} from "../../src/lib/solana/pda";
import type {
  SolanaAccountInfoLike,
  SolanaDeps,
  SolanaInstructionLike
} from "../../src/lib/solana/types";
import {
  clockData,
  contextData,
  fillRecordData,
  localAttestationData
} from "../fixtures/solana/accounts";

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const solver = key(1),
  user = key(2),
  mint = key(3),
  outputMint = key(4),
  recipient = key(5),
  sponsor = key(6);
const solverHex = pubkeyToBytes32(solver);
const chain = SOLANA_DEVNET_CHAIN_ID;
const now = 1_800_000_000;
const settler = pubkeyToBytes32(outputSettlerSimplePda());

function order(): StandardSolana {
  return {
    user: pubkeyToBytes32(user),
    nonce: 7n,
    originChainId: chain,
    expires: now + 1200,
    fillDeadline: now + 600,
    inputOracle: settler,
    inputs: [[BigInt(pubkeyToBytes32(mint)), 1_000_000n]],
    outputs: [
      {
        oracle: settler,
        settler,
        chainId: chain,
        token: pubkeyToBytes32(mint),
        amount: 900_000n,
        recipient: pubkeyToBytes32(recipient),
        callbackData: "0x",
        context: "0x"
      }
    ]
  };
}

const container = (order: StandardSolana) =>
  ({
    order,
    inputSettler: pubkeyToBytes32(inputSettlerEscrowPda()),
    sponsorSignature: { type: "None", payload: "0x" },
    allocatorSignature: { type: "None", payload: "0x" }
  }) as OrderContainer;

function fixture(value = order(), tokenProgram = TOKEN_PROGRAM_ID) {
  const accounts = new Map<string, NonNullable<SolanaAccountInfoLike>>();
  const setAccount = (address: string, owner: string, data: Uint8Array) =>
    accounts.set(address, { owner, data, lamports: 1_000_000 });
  const id = solanaOrderId(value);
  setAccount(CLOCK_SYSVAR, "Sysvar1111111111111111111111111111111111111", clockData(now));
  setAccount(mint.toBase58(), tokenProgram, new Uint8Array(82));
  setAccount(outputMint.toBase58(), tokenProgram, new Uint8Array(82));
  setAccount(
    orderContextPda(id).toBase58(),
    ids.INPUT_SETTLER_ESCROW_PROGRAM_ID,
    contextData(mint.toBase58(), user.toBase58(), sponsor.toBase58())
  );
  const provider = new AnchorProvider(
    new Connection("http://127.0.0.1:8899"),
    {
      publicKey: solver,
      signTransaction: async () => {
        throw Error("Unexpected signing");
      },
      signAllTransactions: async () => {
        throw Error("Unexpected signing");
      }
    },
    {}
  );
  const raw = {
    inputSettlerEscrow: new Program(ids.INPUT_SETTLER_ESCROW_IDL, provider),
    outputSettlerSimple: new Program(ids.OUTPUT_SETTLER_SIMPLE_IDL, provider),
    polymer: new Program(ids.POLYMER_IDL, provider),
    intentsProtocol: new Program(ids.INTENTS_PROTOCOL_IDL, provider)
  };
  const adapt = (p: unknown) =>
    adaptProgram(p as Parameters<typeof adaptProgram>[0], (address) => new PublicKey(address));
  const sent: SolanaInstructionLike[][] = [];
  const deps: SolanaDeps = {
    chainId: chain,
    programs: {
      inputSettlerEscrow: adapt(raw.inputSettlerEscrow),
      outputSettlerSimple: adapt(raw.outputSettlerSimple),
      polymer: adapt(raw.polymer),
      intentsProtocol: adapt(raw.intentsProtocol)
    },
    reads: {
      getGenesisHash: async () => SOLANA_GENESIS_HASHES[chain.toString()],
      getAccountInfo: async (address) => accounts.get(address) ?? null,
      getMultipleAccountsInfo: async (addresses) => addresses.map((a) => accounts.get(a) ?? null),
      getTransaction: async () => null,
      getBalance: async () => 100_000_000n,
      getTokenAccountBalance: async () => 0n,
      getLatestBlockhash: async () => ({ blockhash: key(9).toBase58(), lastValidBlockHeight: 10 })
    },
    signer: {
      publicKey: solver.toBase58(),
      signAndSend: async (instructions) => {
        sent.push(instructions);
        return "confirmed-signature";
      }
    }
  };
  return { deps, raw, sent, accounts, setAccount, id, value };
}

beforeEach(invalidateSolanaClusterGuard);

describe("verified production interfaces", () => {
  test("every vendored artifact matches the upstream provenance", async () => {
    for (const [path, hash] of Object.entries(provenance.files)) {
      const bytes = await Bun.file(
        new URL(`../../src/lib/idl/${path}`, import.meta.url)
      ).arrayBuffer();
      expect(createHash("sha256").update(new Uint8Array(bytes)).digest("hex")).toBe(hash);
    }
    expect(provenance.sourceReferenceCommit).toBe("776773a61a6e4d25370712818d60ee6fb459947a");
  });

  test("account readers agree with Anchor codecs and reject legacy layouts", async () => {
    const protocol = new BorshAccountsCoder(protocolIdl as Idl);
    const output = new BorshAccountsCoder(outputIdl as Idl);
    const local = await protocol.encode("LocalAttestation", {
      timestamp: now,
      bump: 255,
      rent_refund: solver,
      consumed: true
    });
    const info = { owner: ids.INTENTS_PROTOCOL_PROGRAM_ID, data: local, lamports: 10 };
    expect(decodeLocalAttestation(info)).toEqual({
      timestamp: now,
      bump: 255,
      rentRefund: solver.toBase58(),
      consumed: true
    });
    expect(() => decodeLocalAttestation({ ...info, data: local.slice(0, 13) })).toThrow(
      "contract upgrade"
    );
    const record = new Uint8Array(
      await output.encode("FillRecord", {
        rent_refund: solver,
        close_after: new (await import("@coral-xyz/anchor")).BN(now + 172800)
      })
    );
    expect(
      decodeFillRecord({ owner: ids.OUTPUT_SETTLER_SIMPLE_PROGRAM_ID, data: record, lamports: 7 })
        .closeAfter
    ).toBe(BigInt(now + 172800));
    expect(() =>
      decodeFillRecord({
        owner: ids.OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
        data: record.slice(0, 8),
        lamports: 7
      })
    ).toThrow("contract upgrade");
  });
});

describe("atomic issuance and filling", () => {
  for (const native of [false, true])
    for (const tokenProgram of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      test(`builds a single strict-account ${native ? "native" : "token"} transaction with ${tokenProgram}`, async () => {
        const value = order();
        if (native) value.outputs[0].token = `0x${"00".repeat(32)}`;
        const f = fixture(value, tokenProgram);
        await fillAndSettle(f.deps, { order: value, orderId: f.id, solverBytes32: solverHex });
        expect(f.sent).toHaveLength(1);
        expect(f.sent[0]).toHaveLength(2);
        const [release, fill] = f.sent[0];
        expect(release.programId).toBe(ids.INPUT_SETTLER_ESCROW_PROGRAM_ID);
        expect(fill.programId).toBe(ids.OUTPUT_SETTLER_SIMPLE_PROGRAM_ID);
        expect(
          (f.raw.inputSettlerEscrow.coder.instruction as BorshInstructionCoder).decode(
            Buffer.from(release.data)
          )?.name
        ).toBe("finaliseWithPrefill");
        expect(
          (f.raw.outputSettlerSimple.coder.instruction as BorshInstructionCoder).decode(
            Buffer.from(fill.data)
          )?.name
        ).toBe(native ? "nativeFillSamechain" : "fillSamechain");
        expect(release.keys).toHaveLength(13);
        expect(fill.keys).toHaveLength(native ? 5 : 10);
        expect(fill.keys.some((k) => k.pubkey === ids.INTENTS_PROTOCOL_PROGRAM_ID)).toBe(false);
        expect(fill.keys[native ? 3 : 6].pubkey).toBe(
          fillIdPda(f.id, getOutputHash(value.outputs[0])).toBase58()
        );
        const tx = new Transaction({ feePayer: solver, recentBlockhash: key(9).toBase58() }).add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })
        );
        for (const ix of f.sent[0])
          tx.add(
            new TransactionInstruction({
              programId: new PublicKey(ix.programId),
              keys: ix.keys.map((k) => ({ ...k, pubkey: new PublicKey(k.pubkey) })),
              data: Buffer.from(ix.data)
            })
          );
        expect(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length
        ).toBeLessThanOrEqual(1232);
      });
    }

  test("supports different-token direct fills without introducing strategy instructions", async () => {
    const value = order();
    value.outputs[0].token = pubkeyToBytes32(outputMint);
    const f = fixture(value);
    await fillAndSettle(f.deps, { order: value, orderId: f.id, solverBytes32: solverHex });
    expect(f.sent[0]).toHaveLength(2);
    expect(f.sent[0][1].keys[5].pubkey).toBe(outputMint.toBase58());
  });

  test("preserves explicit exclusivity and compresses self exclusivity", async () => {
    const value = order();
    value.outputs[0].context = encodePacked(
      ["bytes1", "bytes32", "uint32"],
      ["0xe0", solverHex, now + 30]
    );
    expect(compactSamechainOrder(value, solverHex).context).toEqual({
      exclusiveForSelf: { startTime: now + 30 }
    });
    const self = fixture(value);
    await fillAndSettle(self.deps, { order: value, orderId: self.id, solverBytes32: solverHex });
    value.outputs[0].context = encodePacked(
      ["bytes1", "bytes32", "uint32"],
      ["0xe0", pubkeyToBytes32(user), now - 30]
    );
    expect(compactSamechainOrder(value, solverHex).context).toEqual({
      exclusiveFor: { exclusiveFor: pubkeyToBytes32(user), startTime: now - 30 }
    });
    const explicit = fixture(value);
    await fillAndSettle(explicit.deps, {
      order: value,
      orderId: explicit.id,
      solverBytes32: solverHex
    });
    value.outputs[0].context = encodePacked(
      ["bytes1", "bytes32", "uint32"],
      ["0xe0", pubkeyToBytes32(user), now + 30]
    );
    const locked = fixture(value);
    await expect(
      fillAndSettle(locked.deps, { order: value, orderId: locked.id, solverBytes32: solverHex })
    ).rejects.toThrow("exclusive to another solver");
    expect(locked.sent).toHaveLength(0);
  });

  test("canonical order hash agrees with the verified IDL's Borsh codec", async () => {
    const f = fixture();
    f.deps.signer.publicKey = user.toBase58();
    await openEscrow(f.deps, { order: f.value, orderId: f.id });
    const decoded = (f.raw.inputSettlerEscrow.coder.instruction as BorshInstructionCoder).decode(
      Buffer.from(f.sent[0][0].data)
    )!;
    const encodedOrder = f.raw.inputSettlerEscrow.coder.types.encode(
      "standardOrder",
      (decoded.data as { order: unknown }).order
    );
    const { keccak256 } = await import("viem");
    expect(keccak256(encodedOrder)).toBe(f.id);
  });

  test("rejects mismatched hashes, solver overrides, clocks, and clusters before signing", async () => {
    const f = fixture();
    await expect(
      fillAndSettle(f.deps, {
        order: f.value,
        orderId: pubkeyToBytes32(key(99)),
        solverBytes32: solverHex
      })
    ).rejects.toThrow("expanded compact order");
    await expect(
      fillAndSettle(f.deps, { order: f.value, orderId: f.id, solverBytes32: pubkeyToBytes32(user) })
    ).rejects.toThrow("recorded solver");
    f.setAccount(CLOCK_SYSVAR, SYSTEM_PROGRAM_ID, clockData(now + 601));
    await expect(
      fillAndSettle(f.deps, { order: f.value, orderId: f.id, solverBytes32: solverHex })
    ).rejects.toThrow("deadline");
    invalidateSolanaClusterGuard();
    f.deps.reads.getGenesisHash = async () => "wrong";
    await expect(
      fillAndSettle(f.deps, { order: f.value, orderId: f.id, solverBytes32: solverHex })
    ).rejects.toThrow("wrong cluster");
    expect(f.sent).toHaveLength(0);
  });

  test("marks unsupported routes ineligible and enforces issuance limits", () => {
    const value = order();
    expect(atomicFillProblem(container(value))).toBeUndefined();
    value.outputs[0].context = "0x01";
    expect(atomicFillProblem(container(value))).toContain("pricing context");
    value.outputs[0].context = "0x";
    value.outputs[0].callbackData = "0xaa";
    expect(atomicFillProblem(container(value))).toContain("callbacks");
    value.outputs[0].callbackData = "0x";
    value.outputs.push({ ...value.outputs[0] });
    expect(() => validateSolanaOrder(value, value.user)).toThrow("transaction limit");
    expect(atomicFillProblem(container(value))).toContain("one input and one output");
    value.outputs.pop();
    value.fillDeadline = value.expires;
    expect(() => validateSolanaOrder(value, value.user)).toThrow("precede expiry");
    value.fillDeadline--;
    value.inputs[0][1] = 1n << 64n;
    expect(() => validateSolanaOrder(value, value.user)).toThrow("u64");
  });
});

describe("ordinary settlement and rent", () => {
  test("ordinary fills retain attestations and Polymer submit stays read-only", async () => {
    const f = fixture();
    const output = {
      ...f.value.outputs[0],
      oracle: pubkeyToBytes32(new PublicKey(ids.POLYMER_PROGRAM_ID))
    };
    await fillOutput(f.deps, {
      orderId: f.id,
      output,
      fillDeadline: now + 600,
      solverBytes32: solverHex
    });
    expect(f.sent[0][0].keys).toHaveLength(12);
    await submitFillProof(f.deps, {
      orderId: f.id,
      output,
      solverBytes32: solverHex,
      timestamp: now
    });
    const submit = f.sent[1][0];
    expect(submit.keys).toHaveLength(2);
    expect(submit.keys.every((k) => !k.isSigner && !k.isWritable)).toBe(true);
  });

  test("finalise appends all attestations then all refund slots, with exact permissions", async () => {
    const value = order();
    value.outputs[0].oracle = pubkeyToBytes32(new PublicKey(ids.INPUT_SETTLER_ESCROW_PROGRAM_ID));
    value.outputs.push({ ...value.outputs[0], chainId: 8453n, amount: 42n });
    const f = fixture(value);
    const local = localAttestationPda(
      outputSettlerSimplePda(),
      value.outputs[0].oracle,
      localAttestationDataHash({ solver: solverHex, orderId: f.id, output: value.outputs[0] })
    ).toBase58();
    f.setAccount(
      local,
      ids.INTENTS_PROTOCOL_PROGRAM_ID,
      localAttestationData(sponsor.toBase58(), now)
    );
    await finalise(f.deps, {
      order: value,
      orderId: f.id,
      solveParams: [
        { solver: solverHex, timestamp: now },
        { solver: solverHex, timestamp: now + 1 }
      ],
      destinationBytes32: solverHex
    });
    const ix = f.sent[0][0];
    expect(ix.keys[9].pubkey).toBe(
      localConsumerPda(ids.INPUT_SETTLER_ESCROW_PROGRAM_ID).toBase58()
    );
    expect(ix.keys.slice(14).map((k) => [k.pubkey, k.isWritable, k.isSigner])).toEqual([
      [local, true, false],
      [ix.keys[15].pubkey, false, false],
      [sponsor.toBase58(), true, false],
      [SYSTEM_PROGRAM_ID, false, false]
    ]);
    f.setAccount(
      local,
      ids.INTENTS_PROTOCOL_PROGRAM_ID,
      localAttestationData(sponsor.toBase58(), now, true)
    );
    await expect(
      readIsLocallyAttested(f.deps.reads, {
        orderId: f.id,
        output: value.outputs[0],
        solver: solverHex
      })
    ).resolves.toBe(false);
    await expect(
      finalise(f.deps, {
        order: value,
        orderId: f.id,
        solveParams: [
          { solver: solverHex, timestamp: now },
          { solver: solverHex, timestamp: now + 1 }
        ],
        destinationBytes32: solverHex
      })
    ).rejects.toThrow("consumed");
  });

  test("reclaim uses the stored refund recipient and strictly exceeds closeAfter", async () => {
    const f = fixture();
    const output = f.value.outputs[0];
    const address = fillIdPda(f.id, getOutputHash(output)).toBase58();
    f.setAccount(
      address,
      ids.OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
      fillRecordData(sponsor.toBase58(), BigInt(now))
    );
    await expect(closeFillRecord(f.deps, { orderId: f.id, output })).rejects.toThrow(
      "not reclaimable yet"
    );
    expect(f.sent).toHaveLength(0);
    f.setAccount(CLOCK_SYSVAR, SYSTEM_PROGRAM_ID, clockData(now + 1));
    await closeFillRecord(f.deps, { orderId: f.id, output });
    expect(f.sent[0][0].keys.map((k) => k.pubkey)).toEqual([
      solver.toBase58(),
      address,
      sponsor.toBase58()
    ]);
    expect(
      (f.raw.outputSettlerSimple.coder.instruction as BorshInstructionCoder).decode(
        Buffer.from(f.sent[0][0].data)
      )?.name
    ).toBe("closeFillRecord");
    f.accounts.delete(address);
    await expect(closeFillRecord(f.deps, { orderId: f.id, output })).rejects.toThrow(
      "already closed"
    );
  });
});
