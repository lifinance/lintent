import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  addressToBytes32,
  encodeFillDescription,
  encodeNotFilledDescription,
  getNotFilledDescriptionHash,
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID
} from "@lifi/intent";
import { Keypair, PublicKey, Secp256k1Program } from "@solana/web3.js";
import {
  createVAA,
  deserialize,
  serialize,
  UniversalAddress
} from "@wormhole-foundation/sdk-definitions";
import type { VAA } from "@wormhole-foundation/sdk-definitions";
import { utils } from "@wormhole-foundation/sdk-solana-core";
import { bytesToHex, hexToBytes, keccak256 } from "viem";
import type { Hex } from "viem";
import {
  COIN_FILLER,
  SOLANA_OUTPUT_SETTLER,
  SOLANA_WORMHOLE_CORE,
  WORMHOLE_ORACLE
} from "../../src/lib/config";
import {
  INPUT_SETTLER_ESCROW_PROGRAM_ID,
  INTENTS_PROTOCOL_PROGRAM_ID,
  OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
  POLYMER_PROGRAM_ID,
  WORMHOLE_PROGRAM_ID
} from "../../src/lib/idl";
import { invalidateSolanaClusterGuard, SOLANA_GENESIS_HASHES } from "../../src/lib/solana/client";
import { localAttestationDataHash } from "../../src/lib/solana/encode";
import {
  CHAIN_MAPPING_DISCRIMINATOR,
  LOCAL_ATTESTATION_DISCRIMINATOR,
  NOT_FILLED_WINDOW_SECS,
  MINT_WINDOW_MARGIN_SECS
} from "../../src/lib/solana/nonFill";
import {
  attestationPda,
  chainMappingPda,
  localAttestationPda,
  outputSettlerSimplePda,
  pubkeyToBytes32,
  SYSTEM_PROGRAM_ID,
  wormholeOraclePda
} from "../../src/lib/solana/pda";
import { publishSolanaWormhole, receiveWormholeVaa } from "../../src/lib/solana/wormhole";
import type { PublishSolanaWormholeArgs } from "../../src/lib/solana/wormhole";
import type {
  SolanaAccountInfoLike,
  SolanaAccountMeta,
  SolanaDeps,
  SolanaInstructionLike,
  SolanaProgramLike,
  SolanaSignerLike
} from "../../src/lib/solana/types";
import { b32, makeMandateOutput, TEST_NOW_SECONDS } from "../fixtures/orderFixtures";

const CORE = new PublicKey(SOLANA_WORMHOLE_CORE);
const ORACLE = wormholeOraclePda();
const ORDER = b32("a");
const SOLVER = b32("b");
const solanaOutput = makeMandateOutput(SOLANA_MAINNET_CHAIN_ID, 123n, {
  oracle: pubkeyToBytes32(ORACLE),
  settler: SOLANA_OUTPUT_SETTLER
});
const evmOutput = makeMandateOutput(8453n, 123n, {
  oracle: addressToBytes32(WORMHOLE_ORACLE[8453]!),
  settler: addressToBytes32(COIN_FILLER)
});
const fillPayload = encodeFillDescription({
  orderId: ORDER,
  solver: SOLVER,
  output: evmOutput,
  timestamp: TEST_NOW_SECONDS
});
const nonFillPayload = encodeNotFilledDescription({
  orderId: ORDER,
  output: evmOutput,
  fillDeadline: TEST_NOW_SECONDS
});

type Call = {
  method: string;
  args: unknown[];
  accounts: Record<string, string>;
  remaining: SolanaAccountMeta[];
};
type SendOptions = Parameters<SolanaSignerLike["signAndSend"]>[1];

function envelope(payloads: Hex[], application: Hex): Uint8Array {
  const parts = payloads.map((payload) => hexToBytes(payload));
  const bytes = new Uint8Array(34 + parts.reduce((size, part) => size + 2 + part.length, 0));
  bytes.set(hexToBytes(application));
  const view = new DataView(bytes.buffer);
  view.setUint16(32, parts.length);
  let offset = 34;
  for (const part of parts) {
    view.setUint16(offset, part.length);
    offset += 2;
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
function coreMessage(vaa: VAA<"Uint8Array">, prefix = "vaa"): Uint8Array {
  const bytes = new Uint8Array(95 + vaa.payload.length);
  // SDK VAA objects omit their validated fixed header version; Core persists version 1.
  bytes.set(new TextEncoder().encode(prefix));
  bytes[3] = 1;
  bytes[4] = vaa.consistencyLevel;
  const view = new DataView(bytes.buffer);
  view.setUint32(5, vaa.timestamp, true);
  view.setUint32(41, vaa.timestamp + 10, true);
  view.setUint32(45, vaa.nonce, true);
  view.setBigUint64(49, vaa.sequence, true);
  view.setUint16(57, prefix === "msg" ? 1 : 30, true);
  bytes.set(vaa.emitterAddress.toUint8Array(), 59);
  view.setUint32(91, vaa.payload.length, true);
  bytes.set(vaa.payload, 95);
  return bytes;
}
function signedVaa(
  payloads: Hex[] = [fillPayload],
  signatureCount = 8,
  changes: Record<string, unknown> = {}
): VAA<"Uint8Array"> {
  const unsigned = serialize(
    createVAA("Uint8Array", {
      guardianSet: 4,
      signatures: [],
      timestamp: TEST_NOW_SECONDS,
      nonce: 0,
      emitterChain: "Base",
      emitterAddress: new UniversalAddress(hexToBytes(evmOutput.oracle)),
      sequence: 9007199254740993n,
      consistencyLevel: 15,
      payload: envelope(payloads, evmOutput.settler),
      ...changes
    })
  );
  const bytes = new Uint8Array(unsigned.length + signatureCount * 66);
  bytes.set(unsigned.subarray(0, 6));
  bytes[5] = signatureCount;
  for (let i = 0; i < signatureCount; i++) {
    const offset = 6 + i * 66;
    bytes[offset] = i;
    bytes[offset + 32] = 1;
    bytes[offset + 64] = 1;
  }
  bytes.set(unsigned.subarray(6), 6 + signatureCount * 66);
  return deserialize("Uint8Array", bytes);
}
function signatureData(vaa: VAA<"Uint8Array">, flags = new Uint8Array(19)): Uint8Array {
  const bytes = new Uint8Array(4 + flags.length + 36);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, flags.length, true);
  bytes.set(flags, 4);
  bytes.set(vaa.hash, 4 + flags.length);
  view.setUint32(4 + flags.length + 32, vaa.guardianSet, true);
  return bytes;
}

function fixture() {
  const accounts = new Map<string, NonNullable<SolanaAccountInfoLike>>();
  const calls: Call[] = [];
  const sent: { instructions: SolanaInstructionLike[]; options: SendOptions }[] = [];
  const payer = Keypair.generate().publicKey.toBase58();
  const state = new Uint8Array(89);
  state.set(hexToBytes("0xdacfeebe62a303c7"));
  state.set(CORE.toBytes(), 40);
  let id = BigInt(SOLANA_MAINNET_CHAIN_ID);
  for (let i = 72; i < 88; i++) {
    state[i] = Number(id & 255n);
    id >>= 8n;
  }
  state[88] = PublicKey.findProgramAddressSync(
    [Buffer.from("wormhole")],
    new PublicKey(WORMHOLE_PROGRAM_ID)
  )[1];
  const put = (address: string, data: Uint8Array, owner = CORE.toBase58(), executable = false) => {
    accounts.set(address, { owner, data, executable, lamports: 1 });
  };
  put(ORACLE.toBase58(), state, WORMHOLE_PROGRAM_ID);
  for (const program of [WORMHOLE_PROGRAM_ID, OUTPUT_SETTLER_SIMPLE_PROGRAM_ID, CORE.toBase58()])
    put(program, new Uint8Array(), SYSTEM_PROGRAM_ID, true);
  put(outputSettlerSimplePda().toBase58(), new Uint8Array(), OUTPUT_SETTLER_SIMPLE_PROGRAM_ID);
  const mapping = new Uint8Array(25);
  mapping.set(CHAIN_MAPPING_DISCRIMINATOR);
  new DataView(mapping.buffer).setBigUint64(8, 8453n, true);
  put(chainMappingPda(ORACLE, 30n).toBase58(), mapping, INTENTS_PROTOCOL_PROGRAM_ID);
  const guardian = new Uint8Array(16 + 19 * 20);
  const gv = new DataView(guardian.buffer);
  gv.setUint32(0, 4, true);
  gv.setUint32(4, 19, true);
  for (let i = 0; i < 19; i++) guardian.fill(i + 1, 8 + i * 20, 8 + (i + 1) * 20);
  put(utils.deriveGuardianSetKey(CORE, 4).toBase58(), guardian);
  const makeProgram = (programId: string): SolanaProgramLike => ({
    programId,
    methods: new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== "string" || method === "then") return undefined;
          return (...args: unknown[]) => {
            const call: Call = { method, args, accounts: {}, remaining: [] };
            calls.push(call);
            const builder = {
              accounts(value: Record<string, string>) {
                call.accounts = value;
                return builder;
              },
              remainingAccounts(value: SolanaAccountMeta[]) {
                call.remaining = value;
                return builder;
              },
              async instruction(): Promise<SolanaInstructionLike> {
                return {
                  programId,
                  keys: [
                    ...Object.entries(call.accounts).map(([name, pubkey]) => ({
                      pubkey,
                      isSigner: name === "postMessage" || name === "submitter" || name === "signer",
                      isWritable: true
                    })),
                    ...call.remaining
                  ],
                  data: Uint8Array.of(method === "submit" ? 1 : 2)
                };
              }
            };
            return builder;
          };
        }
      }
    )
  });
  let chainTime = TEST_NOW_SECONDS + 1;
  let onSend: (
    instructions: SolanaInstructionLike[],
    options: SendOptions
  ) => Promise<void> = async () => {};
  const deps: SolanaDeps = {
    chainId: BigInt(SOLANA_MAINNET_CHAIN_ID),
    reads: {
      getGenesisHash: async () =>
        SOLANA_GENESIS_HASHES[BigInt(SOLANA_MAINNET_CHAIN_ID).toString()]!,
      getAccountInfo: async (address) => accounts.get(address) ?? null,
      getMultipleAccountsInfo: async (addresses) =>
        addresses.map((address) => accounts.get(address) ?? null),
      getTransaction: async () => null,
      getBalance: async () => 0n,
      getTokenAccountBalance: async () => 0n,
      getLatestBlockhash: async () => ({
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 1
      }),
      getSignaturesForAddress: async () => [],
      getFinalizedBlockTime: async () => chainTime
    },
    programs: {
      inputSettlerEscrow: makeProgram(INPUT_SETTLER_ESCROW_PROGRAM_ID),
      outputSettlerSimple: makeProgram(OUTPUT_SETTLER_SIMPLE_PROGRAM_ID),
      polymer: makeProgram(POLYMER_PROGRAM_ID),
      wormhole: makeProgram(WORMHOLE_PROGRAM_ID),
      intentsProtocol: makeProgram(INTENTS_PROTOCOL_PROGRAM_ID)
    },
    signer: {
      publicKey: payer,
      async signAndSend(instructions, options) {
        await options?.beforeSign?.();
        sent.push({ instructions, options });
        await onSend(instructions, options);
        return `signature-${sent.length}`;
      }
    }
  };
  function local(
    args: PublishSolanaWormholeArgs,
    kind: "current" | "legacy" | "consumed" = "current",
    owner = INTENTS_PROTOCOL_PROGRAM_ID
  ) {
    const bytes = new Uint8Array(kind === "legacy" ? 13 : 46);
    bytes.set(LOCAL_ATTESTATION_DISCRIMINATOR);
    new DataView(bytes.buffer).setUint32(8, args.timestamp, true);
    if (bytes.length === 46) {
      bytes.set(hexToBytes(b32("c")), 13);
      bytes[45] = kind === "consumed" ? 1 : 0;
    }
    const hash =
      args.kind === "fill"
        ? localAttestationDataHash({
            solver: args.solverBytes32,
            orderId: args.orderId,
            output: args.output
          })
        : getNotFilledDescriptionHash({
            orderId: args.orderId,
            output: args.output,
            fillDeadline: args.timestamp
          });
    const address = localAttestationPda(
      outputSettlerSimplePda(),
      args.output.oracle,
      hash
    ).toBase58();
    put(address, bytes, owner);
    return address;
  }
  function publication(args: PublishSolanaWormholeArgs, owner = CORE.toBase58()) {
    onSend = async (_instructions, options) => {
      const message = Keypair.fromSecretKey(options!.additionalSigners![0]!.secretKey);
      const vaa = createVAA("Uint8Array", {
        guardianSet: 4,
        signatures: [],
        timestamp: args.timestamp,
        nonce: 0,
        emitterChain: "Solana",
        emitterAddress: new UniversalAddress(hexToBytes(args.output.oracle)),
        sequence: 9007199254740993n,
        consistencyLevel: 32,
        payload: envelope([args.payload], args.output.settler)
      });
      put(message.publicKey.toBase58(), coreMessage(vaa, "msg"), owner);
    };
  }
  function delivery(vaa: VAA<"Uint8Array">, failReceive = false) {
    onSend = async (instructions, options) => {
      if (instructions[0]!.programId === Secp256k1Program.programId.toBase58()) {
        const key = Keypair.fromSecretKey(
          options!.additionalSigners![0]!.secretKey
        ).publicKey.toBase58();
        const existing = accounts.get(key)?.data;
        const flags = existing ? existing.slice(4, 23) : new Uint8Array(19);
        for (let i = 0; i < 19; i++) if (instructions[1]!.data[i + 1] !== 255) flags[i] = 1;
        put(key, signatureData(vaa, flags));
      } else if (instructions[0]!.programId === CORE.toBase58()) {
        put(utils.derivePostedVaaKey(CORE, Buffer.from(vaa.hash)).toBase58(), coreMessage(vaa));
      } else {
        if (failReceive) throw new Error("receive rejected");
        for (const meta of calls.at(-1)!.remaining)
          put(meta.pubkey, new Uint8Array(), INTENTS_PROTOCOL_PROGRAM_ID);
      }
    };
  }
  return {
    deps,
    accounts,
    calls,
    sent,
    put,
    local,
    publication,
    delivery,
    setTime(value: number) {
      chainTime = value;
    },
    setOnSend(value: typeof onSend) {
      onSend = value;
    }
  };
}

beforeEach(() => {
  invalidateSolanaClusterGuard();
  spyOn(Date, "now").mockReturnValue((TEST_NOW_SECONDS + 1) * 1000);
});
afterEach(() => {
  mock.restore();
});

function publishArgs(
  kind: "fill" | "non-fill" = "fill",
  timestamp = TEST_NOW_SECONDS
): PublishSolanaWormholeArgs {
  const common = { orderId: ORDER, output: solanaOutput, timestamp };
  return kind === "fill"
    ? {
        ...common,
        kind,
        solverBytes32: SOLVER,
        payload: encodeFillDescription({ ...common, solver: SOLVER })
      }
    : {
        ...common,
        kind,
        payload: encodeNotFilledDescription({ ...common, fillDeadline: timestamp })
      };
}

describe("Solana Wormhole publication", () => {
  test("consumes the recorded fill rent recipient and returns actual uint64 message identity", async () => {
    const f = fixture();
    const args = publishArgs();
    const local = f.local(args);
    f.publication(args);
    const publication = await publishSolanaWormhole(f.deps, args);
    expect(publication.id.sequence).toBe("9007199254740993");
    expect(publication.consistencyLevel).toBe(32);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.options!.additionalSigners).toHaveLength(1);
    expect(f.calls[0]!.remaining).toEqual([
      { pubkey: local, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(hexToBytes(b32("c"))).toBase58(), isSigner: false, isWritable: true }
    ]);
    expect(f.calls[0]!.accounts.wormholeSequence).toBe(
      PublicKey.findProgramAddressSync(
        [Buffer.from("Sequence"), ORACLE.toBuffer()],
        CORE
      )[0].toBase58()
    );
    expect(f.sent[0]!.instructions).toHaveLength(1);
  });
  test("absent non-fill mints and consumes atomically; an existing record submits only", async () => {
    for (const existing of [false, true]) {
      const f = fixture();
      const args = publishArgs("non-fill");
      if (existing) f.local(args);
      f.publication(args);
      await publishSolanaWormhole(f.deps, args);
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]!.instructions).toHaveLength(existing ? 1 : 2);
      expect(f.calls[0]!.remaining[1]!.pubkey).toBe(
        existing ? new PublicKey(hexToBytes(b32("c"))).toBase58() : f.deps.signer.publicKey
      );
    }
  });
  test.each(["legacy", "consumed"] as const)("%s record never spends", async (kind) => {
    const f = fixture();
    const args = publishArgs();
    f.local(args, kind);
    await expect(publishSolanaWormhole(f.deps, args)).rejects.toThrow("Recover its publication");
    expect(f.sent).toHaveLength(0);
  });
  test("wrong local owner, timestamp or payload is rejected before signing", async () => {
    const f = fixture();
    const args = publishArgs();
    const address = f.local(args, "current", SYSTEM_PROGRAM_ID);
    await expect(publishSolanaWormhole(f.deps, args)).rejects.toThrow("unexpected program");
    f.local(args);
    new DataView(f.accounts.get(address)!.data.buffer).setUint32(8, args.timestamp + 1, true);
    await expect(publishSolanaWormhole(f.deps, args)).rejects.toThrow("timestamp");
    await expect(publishSolanaWormhole(f.deps, { ...args, payload: "0xd1252dff" })).rejects.toThrow(
      "exact signed"
    );
    expect(f.sent).toHaveLength(0);
  });
  test.each([0, NOT_FILLED_WINDOW_SECS - MINT_WINDOW_MARGIN_SECS + 1])(
    "absent record deadline/window boundary %i prevents spend",
    async (offset) => {
      const f = fixture();
      const args = publishArgs("non-fill");
      f.setTime(args.timestamp + offset);
      spyOn(Date, "now").mockReturnValue((args.timestamp + offset) * 1000);
      await expect(publishSolanaWormhole(f.deps, args)).rejects.toThrow();
      expect(f.sent).toHaveLength(0);
    }
  );
  test("inclusive safety-margin boundary is usable; existing non-fill can submit beyond mint window", async () => {
    for (const existing of [false, true]) {
      const f = fixture();
      const args = publishArgs("non-fill");
      const time =
        args.timestamp + NOT_FILLED_WINDOW_SECS - MINT_WINDOW_MARGIN_SECS + (existing ? 1000 : 0);
      spyOn(Date, "now").mockReturnValue(time * 1000);
      f.setTime(time);
      if (existing) f.local(args);
      f.publication(args);
      await publishSolanaWormhole(f.deps, args);
      expect(f.sent).toHaveLength(1);
    }
  });
  test("finalized clock unavailability and stale beforeSign guard prevent publication", async () => {
    const f = fixture();
    const args = publishArgs("non-fill");
    f.deps.reads.getFinalizedBlockTime = async () => {
      throw new Error("RPC unavailable");
    };
    await expect(publishSolanaWormhole(f.deps, args)).rejects.toThrow("chain time unavailable");
    f.deps.reads.getFinalizedBlockTime = async () => TEST_NOW_SECONDS + 1;
    await expect(
      publishSolanaWormhole(f.deps, {
        ...args,
        beforeSpend: async () => {
          throw new Error("now filled");
        }
      })
    ).rejects.toThrow("now filled");
    expect(f.sent).toHaveLength(0);
  });
  test("wrong Core message owner never returns a publication", async () => {
    const f = fixture();
    const args = publishArgs();
    f.local(args);
    f.publication(args, SYSTEM_PROGRAM_ID);
    await expect(publishSolanaWormhole(f.deps, args)).rejects.toThrow("foreign-owned");
  });
  test.each([
    "state-owner",
    "state-length",
    "state-discriminator",
    "core",
    "program",
    "chain",
    "devnet"
  ])("rejects incompatible %s before spend", async (kind) => {
    const f = fixture();
    const args = publishArgs();
    f.local(args);
    const state = f.accounts.get(ORACLE.toBase58())!;
    if (kind === "state-owner") state.owner = SYSTEM_PROGRAM_ID;
    if (kind === "state-length") state.data = state.data.slice(0, 88);
    if (kind === "state-discriminator") state.data[0] = 0;
    if (kind === "core") state.data.fill(0, 40, 72);
    if (kind === "program") f.accounts.get(WORMHOLE_PROGRAM_ID)!.executable = false;
    if (kind === "chain") state.data[72] ^= 1;
    if (kind === "devnet") f.deps.chainId = BigInt(SOLANA_DEVNET_CHAIN_ID);
    await expect(publishSolanaWormhole(f.deps, args)).rejects.toThrow();
    expect(f.sent).toHaveLength(0);
  });
});

describe("Solana Wormhole Core delivery", () => {
  test("stale guard after Core posting blocks registration and retry reuses the real PostedVAA", async () => {
    const f = fixture();
    const vaa = signedVaa();
    f.delivery(vaa);
    let guards = 0;
    const args = {
      output: evmOutput,
      proof: bytesToHex(serialize(vaa)),
      payloadHash: keccak256(fillPayload)
    };
    await expect(
      receiveWormholeVaa(f.deps, {
        ...args,
        beforeSpend: async () => {
          if (++guards === 4) throw new Error("refund no longer eligible");
        }
      })
    ).rejects.toThrow("refund no longer eligible");
    expect(f.sent).toHaveLength(3);
    expect(f.accounts.has(utils.derivePostedVaaKey(CORE, Buffer.from(vaa.hash)).toBase58())).toBe(
      true
    );
    const result = await receiveWormholeVaa(f.deps, args);
    expect(f.sent).toHaveLength(4);
    expect(result.attestSignature).toBe("signature-4");
    expect(f.sent[3]!.instructions[0]!.programId).toBe(WORMHOLE_PROGRAM_ID);
  });
  test("foreign-owned guardian and incorrect canonical mapping block all Core spends", async () => {
    const args = {
      output: evmOutput,
      proof: bytesToHex(serialize(signedVaa())),
      payloadHash: keccak256(fillPayload)
    };
    const guardianFixture = fixture();
    guardianFixture.accounts.get(utils.deriveGuardianSetKey(CORE, 4).toBase58())!.owner =
      SYSTEM_PROGRAM_ID;
    await expect(receiveWormholeVaa(guardianFixture.deps, args)).rejects.toThrow("guardian set");
    expect(guardianFixture.sent).toHaveLength(0);
    const mappingFixture = fixture();
    mappingFixture.accounts.get(chainMappingPda(ORACLE, 30n).toBase58())!.data[8] ^= 1;
    await expect(receiveWormholeVaa(mappingFixture.deps, args)).rejects.toThrow("mapping");
    expect(mappingFixture.sent).toHaveLength(0);
  });
  test("7-signature pairs stay secp-first, then post and register ALL envelope payloads in order", async () => {
    const f = fixture();
    const vaa = signedVaa([nonFillPayload, fillPayload]);
    f.delivery(vaa);
    const stages: string[] = [];
    const result = await receiveWormholeVaa(f.deps, {
      output: evmOutput,
      proof: bytesToHex(serialize(vaa)),
      payloadHash: keccak256(fillPayload),
      onProgress: (stage) => stages.push(stage)
    });
    expect(f.sent).toHaveLength(4);
    for (const sent of f.sent.slice(0, 2)) {
      expect(sent.instructions).toHaveLength(2);
      expect(sent.instructions[0]!.programId).toBe(Secp256k1Program.programId.toBase58());
      expect(sent.options!.computeUnitLimit).toBeUndefined();
      expect(sent.options!.additionalSigners).toHaveLength(1);
      expect(sent.instructions[0]!.data[3]).toBe(0);
    }
    expect(f.sent[0]!.instructions[0]!.data[0]).toBe(7);
    expect(f.sent[1]!.instructions[0]!.data[0]).toBe(1);
    expect(stages.slice(-3)).toEqual(["Verify guardian signatures", "Post VAA", "Register proof"]);
    expect(result.attestSignature).toBe("signature-4");
    const receive = f.calls.at(-1)!;
    expect(receive.method).toBe("receive");
    expect(receive.args).toEqual([]);
    expect(receive.remaining).toEqual(
      [nonFillPayload, fillPayload].map((payload) => ({
        pubkey: attestationPda(
          ORACLE,
          evmOutput.chainId,
          evmOutput.oracle,
          evmOutput.settler,
          keccak256(payload)
        ).toBase58(),
        isSigner: false,
        isWritable: true
      }))
    );
  });
  test("confirmed signature batches resume using the same keypair after a stale guard blocks the next spend", async () => {
    const f = fixture();
    const vaa = signedVaa();
    f.delivery(vaa);
    let guards = 0;
    const args = {
      output: evmOutput,
      proof: bytesToHex(serialize(vaa)),
      payloadHash: keccak256(fillPayload)
    };
    await expect(
      receiveWormholeVaa(f.deps, {
        ...args,
        beforeSpend: async () => {
          if (++guards === 2) throw new Error("order now filled");
        }
      })
    ).rejects.toThrow("order now filled");
    expect(f.sent).toHaveLength(1);
    const secret = f.sent[0]!.options!.additionalSigners![0]!.secretKey;
    const result = await receiveWormholeVaa(f.deps, args);
    expect(f.sent).toHaveLength(4);
    expect(f.sent[1]!.instructions[0]!.data[0]).toBe(1);
    expect(f.sent[1]!.options!.additionalSigners![0]!.secretKey).toEqual(secret);
    expect(result.attestSignature).toBeDefined();
  });
  test("already registered generic proof skips ALL transactions", async () => {
    const f = fixture();
    const vaa = signedVaa();
    const pda = attestationPda(
      ORACLE,
      evmOutput.chainId,
      evmOutput.oracle,
      evmOutput.settler,
      keccak256(fillPayload)
    ).toBase58();
    f.put(pda, new Uint8Array(), INTENTS_PROTOCOL_PROGRAM_ID);
    const result = await receiveWormholeVaa(f.deps, {
      output: evmOutput,
      proof: bytesToHex(serialize(vaa)),
      payloadHash: keccak256(fillPayload)
    });
    expect(result).toEqual({ attestation: pda });
    expect(f.sent).toHaveLength(0);
  });
  test("valid existing PostedVAA skips verify/post but still requires registered proof", async () => {
    const f = fixture();
    const vaa = signedVaa();
    f.delivery(vaa, true);
    f.put(utils.derivePostedVaaKey(CORE, Buffer.from(vaa.hash)).toBase58(), coreMessage(vaa));
    const args = {
      output: evmOutput,
      proof: bytesToHex(serialize(vaa)),
      payloadHash: keccak256(fillPayload)
    };
    await expect(receiveWormholeVaa(f.deps, args)).rejects.toThrow("receive rejected");
    expect(f.sent).toHaveLength(1);
    f.delivery(vaa);
    const result = await receiveWormholeVaa(f.deps, args);
    expect(f.sent).toHaveLength(2);
    expect(result.attestSignature).toBe("signature-2");
  });
  test.each(["owner", "prefix", "version", "timestamp", "sequence", "payload"])(
    "invalid existing PostedVAA %s never spends",
    async (kind) => {
      const f = fixture();
      const vaa = signedVaa();
      const bytes = coreMessage(vaa);
      if (kind === "prefix") bytes[0] = 0;
      if (kind === "version") bytes[3] = 2;
      if (kind === "timestamp") bytes[5] ^= 1;
      if (kind === "sequence") bytes[49] ^= 1;
      if (kind === "payload") bytes[bytes.length - 1] ^= 1;
      f.put(
        utils.derivePostedVaaKey(CORE, Buffer.from(vaa.hash)).toBase58(),
        bytes,
        kind === "owner" ? SYSTEM_PROGRAM_ID : CORE.toBase58()
      );
      await expect(
        receiveWormholeVaa(f.deps, {
          output: evmOutput,
          proof: bytesToHex(serialize(vaa)),
          payloadHash: keccak256(fillPayload)
        })
      ).rejects.toThrow();
      expect(f.sent).toHaveLength(0);
    }
  );
  test.each(["owner", "hash", "guardian", "flag"])(
    "corrupted retained signature-set %s cannot skip batches",
    async (kind) => {
      const f = fixture();
      const vaa = signedVaa();
      f.delivery(vaa);
      let guards = 0;
      const args = {
        output: evmOutput,
        proof: bytesToHex(serialize(vaa)),
        payloadHash: keccak256(fillPayload)
      };
      await expect(
        receiveWormholeVaa(f.deps, {
          ...args,
          beforeSpend: async () => {
            if (++guards === 2) throw new Error("pause");
          }
        })
      ).rejects.toThrow("pause");
      const key = Keypair.fromSecretKey(
        f.sent[0]!.options!.additionalSigners![0]!.secretKey
      ).publicKey.toBase58();
      const account = f.accounts.get(key)!;
      if (kind === "owner") account.owner = SYSTEM_PROGRAM_ID;
      if (kind === "hash") account.data[23] ^= 1;
      if (kind === "guardian") account.data[55] ^= 1;
      if (kind === "flag") account.data[4] = 2;
      await expect(receiveWormholeVaa(f.deps, args)).rejects.toThrow();
      expect(f.sent).toHaveLength(1);
    }
  );
  test("proof for altered signed output and wrong emitter fail before wallet", async () => {
    const f = fixture();
    const vaa = signedVaa();
    await expect(
      receiveWormholeVaa(f.deps, {
        output: { ...evmOutput, amount: 124n },
        proof: bytesToHex(serialize(vaa)),
        payloadHash: keccak256(fillPayload)
      })
    ).rejects.toThrow("exact signed output");
    const wrong = signedVaa([fillPayload], 8, {
      emitterAddress: new UniversalAddress(hexToBytes(b32("c")))
    });
    await expect(
      receiveWormholeVaa(f.deps, {
        output: evmOutput,
        proof: bytesToHex(serialize(wrong)),
        payloadHash: keccak256(fillPayload)
      })
    ).rejects.toThrow("emitter");
    expect(f.sent).toHaveLength(0);
  });
  test("confirmed Core intermediates without final proof never resolve success", async () => {
    const f = fixture();
    const vaa = signedVaa();
    f.delivery(vaa);
    const original = f.deps.signer.signAndSend;
    f.deps.signer.signAndSend = async (instructions, options) => {
      if (instructions[0]!.programId === WORMHOLE_PROGRAM_ID) {
        await options?.beforeSign?.();
        return "receive-no-proof";
      }
      return original(instructions, options);
    };
    await expect(
      receiveWormholeVaa(f.deps, {
        output: evmOutput,
        proof: bytesToHex(serialize(vaa)),
        payloadHash: keccak256(fillPayload)
      })
    ).rejects.toThrow("did not register");
    expect(f.sent).toHaveLength(3);
  });
});
