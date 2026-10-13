import { beforeEach, describe, expect, test } from "bun:test";
import { SOLANA_DEVNET_CHAIN_ID, getOutputHash } from "@lifi/intent";
import type { MandateOutput, StandardSolana } from "@lifi/intent";
import {
  INPUT_SETTLER_ESCROW_PROGRAM_ID,
  INPUT_SETTLER_ESCROW_IDL,
  INTENTS_PROTOCOL_PROGRAM_ID,
  OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
  POLYMER_PROGRAM_ID,
  WORMHOLE_PROGRAM_ID
} from "../../src/lib/idl";
import { SOLANA_GENESIS_HASHES, invalidateSolanaClusterGuard } from "../../src/lib/solana/client";
import { fillPayloadHash, localAttestationDataHash } from "../../src/lib/solana/encode";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  associatedTokenAddress,
  attestationPda,
  bytes32ToPubkey,
  polymerOraclePda,
  consumedOrderPda,
  fillIdPda,
  localAttestationPda,
  orderContextPda,
  outputSettlerSimplePda,
  pubkeyToBytes32
} from "../../src/lib/solana/pda";
import type {
  SolanaAccountInfoLike,
  SolanaAccountMeta,
  SolanaDeps,
  SolanaInstructionBuilder,
  SolanaInstructionLike,
  SolanaProgramLike,
  SolanaProgramsLike
} from "../../src/lib/solana/types";
import {
  fillOutput,
  fillOutputs,
  finalise,
  openEscrow,
  receiveProof,
  recordNotFilled,
  refund,
  refundOnNonFill,
  submitFillProof
} from "../../src/lib/solana/writes";
import { getNotFilledDescriptionHash } from "@lifi/intent";
import {
  ATTEST_NOT_FILLED_DISCRIMINATOR,
  LOCAL_ATTESTATION_DISCRIMINATOR,
  REFUND_ON_NON_FILL_DISCRIMINATOR,
  SUBMIT_CONSUME_DISCRIMINATOR
} from "../../src/lib/solana/nonFill";
import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, BorshInstructionCoder, Program } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";

const CHAIN_ID = SOLANA_DEVNET_CHAIN_ID;
const DEVNET_GENESIS = SOLANA_GENESIS_HASHES[CHAIN_ID.toString()]!;

const b32 = (nibble: string) => `0x${nibble.repeat(64)}` as `0x${string}`;
const ORDER_ID = b32("6");

// A real, on-curve key so PublicKey accepts it; its bytes32 form is the
// identity the order carries.
const USER = "BkEw3WHFvJR9a5deUcwPLJ79yK3r9YGdQ61TehFXzAQ";
const USER_B32 = pubkeyToBytes32(bytes32ToPubkey(b32("0")));
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT_B32 = "0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61" as const;

type RecordedCall = {
  program: string;
  method: string;
  args: unknown[];
  accounts?: Record<string, string>;
  remaining?: SolanaAccountMeta[];
};

/**
 * Programs whose every instruction is synthesised on demand and recorded.
 *
 * Mirrors the Tron mock in tronWrites.test.ts, including the `then` guard: a
 * Proxy that answers `then` is a thenable, and awaiting it never settles.
 */
function makePrograms(calls: RecordedCall[]): SolanaProgramsLike {
  const make = (program: string, programId: string): SolanaProgramLike => ({
    programId,
    methods: new Proxy({} as SolanaProgramLike["methods"], {
      get(_target, method) {
        if (typeof method !== "string" || method === "then") return undefined;
        return (...args: unknown[]) => {
          const call: RecordedCall = { program, method, args };
          calls.push(call);
          const builder = {
            accounts(accounts: Record<string, string>) {
              call.accounts = accounts;
              return builder;
            },
            remainingAccounts(remaining: SolanaAccountMeta[]) {
              call.remaining = remaining;
              return builder;
            },
            async instruction(): Promise<SolanaInstructionLike> {
              return { programId, keys: [], data: new Uint8Array() };
            }
          };
          return builder;
        };
      }
    })
  });

  return {
    inputSettlerEscrow: make("inputSettlerEscrow", INPUT_SETTLER_ESCROW_PROGRAM_ID),
    outputSettlerSimple: make("outputSettlerSimple", OUTPUT_SETTLER_SIMPLE_PROGRAM_ID),
    polymer: make("polymer", POLYMER_PROGRAM_ID),
    wormhole: make("wormhole", WORMHOLE_PROGRAM_ID),
    intentsProtocol: make("intentsProtocol", INTENTS_PROTOCOL_PROGRAM_ID)
  };
}

function makeDeps(
  opts: {
    accounts?: Record<string, { owner: string; data?: Uint8Array }>;
    signerPublicKey?: string;
    genesis?: string;
    chainTime?: number;
  } = {}
) {
  const calls: RecordedCall[] = [];
  const sent: SolanaInstructionLike[][] = [];
  const accounts = opts.accounts ?? { [MINT]: { owner: TOKEN_PROGRAM_ID } };

  const deps: SolanaDeps = {
    chainId: CHAIN_ID,
    reads: {
      rpcEndpoint: "https://test.invalid",
      getGenesisHash: async () => opts.genesis ?? DEVNET_GENESIS,
      getAccountInfo: async (address) => {
        const account = accounts[address];
        return account
          ? ({
              owner: account.owner,
              lamports: 1,
              data: account.data ?? new Uint8Array()
            } as SolanaAccountInfoLike)
          : null;
      },
      getMultipleAccountsInfo: async (addresses) =>
        addresses.map((address) => {
          const account = accounts[address];
          return account
            ? ({
                owner: account.owner,
                lamports: 1,
                data: account.data ?? new Uint8Array()
              } as SolanaAccountInfoLike)
            : null;
        }),
      getTransaction: async () => null,
      getBalance: async () => 0n,
      getTokenAccountBalance: async () => 0n,
      getLatestBlockhash: async () => ({ blockhash: "hash", lastValidBlockHeight: 1 }),
      getSignaturesForAddress: async () => [],
      getFinalizedBlockTime: async () => {
        if (opts.chainTime === undefined) throw new Error("no block time");
        return opts.chainTime;
      }
    },
    signer: {
      publicKey: opts.signerPublicKey ?? USER,
      signAndSend: async (instructions) => {
        sent.push(instructions);
        return `sig${sent.length}`;
      }
    },
    programs: makePrograms(calls)
  };

  return { deps, calls, sent };
}

/**
 * A raw OrderContext account.
 *
 * Layout (input_settler_escrow/src/state/input_settler_escrow.rs):
 *   discriminator[8] | input_token: Pubkey | user: Pubkey | sponsor: Pubkey | bump
 * The sponsor is at byte 72 — reading it from byte 8 yields `input_token`.
 */
function orderContextData(opts: { inputToken: string; user: string; sponsor: string }): Uint8Array {
  const data = new Uint8Array(8 + 32 + 32 + 32 + 1);
  data.set(new PublicKey(opts.inputToken).toBytes(), 8);
  data.set(new PublicKey(opts.user).toBytes(), 40);
  data.set(new PublicKey(opts.sponsor).toBytes(), 72);
  return data;
}

function makeOutput(overrides: Partial<MandateOutput> = {}): MandateOutput {
  return {
    oracle: pubkeyToBytes32(bytes32ToPubkey(b32("1"))),
    settler: pubkeyToBytes32(outputSettlerSimplePda()),
    chainId: CHAIN_ID,
    token: MINT_B32,
    amount: 1_000_000n,
    recipient: pubkeyToBytes32(bytes32ToPubkey(b32("4"))),
    callbackData: "0x",
    context: "0x",
    ...overrides
  } as MandateOutput;
}

function makeOrder(overrides: Partial<StandardSolana> = {}): StandardSolana {
  return {
    user: pubkeyToBytes32(bytes32ToPubkey(USER_B32)),
    nonce: 1n,
    originChainId: CHAIN_ID,
    expires: 1_700_001_000,
    fillDeadline: 1_700_000_900,
    inputOracle: pubkeyToBytes32(bytes32ToPubkey(b32("8"))),
    inputs: [[BigInt(MINT_B32), 1_000_000n]],
    outputs: [makeOutput()],
    ...overrides
  } as StandardSolana;
}

beforeEach(() => {
  invalidateSolanaClusterGuard();
});

describe("cluster guard", () => {
  test("refuses to sign against a wrong-cluster RPC", async () => {
    // The wallet can be pointed anywhere; only the genesis hash identifies the
    // cluster actually being written to.
    const order = makeOrder();
    const { deps } = makeDeps({
      genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      signerPublicKey: bytes32ToPubkey(order.user as `0x${string}`).toBase58()
    });
    await expect(openEscrow(deps, { order, orderId: ORDER_ID })).rejects.toThrow(
      /Refusing to sign against the wrong cluster/
    );
  });
});

describe("openEscrow", () => {
  test("passes the full account set including consumed_order and the vault", async () => {
    const order = makeOrder();
    const user = bytes32ToPubkey(order.user as `0x${string}`).toBase58();
    const { deps, calls, sent } = makeDeps({
      signerPublicKey: user,
      accounts: { [MINT]: { owner: TOKEN_PROGRAM_ID } }
    });

    const signature = await openEscrow(deps, { order, orderId: ORDER_ID });

    expect(signature).toBe("sig1");
    expect(sent).toHaveLength(1);
    const call = calls.find((c) => c.method === "open")!;
    expect(call.program).toBe("inputSettlerEscrow");
    // consumed_order is the replay guard and is easy to omit — the reference
    // test in catalyst-intent-svm predates it and does exactly that.
    expect(call.accounts?.consumedOrder).toBe(consumedOrderPda(ORDER_ID).toBase58());
    expect(call.accounts?.orderContext).toBe(orderContextPda(ORDER_ID).toBase58());
    expect(call.accounts?.tokenProgram).toBe(TOKEN_PROGRAM_ID);
    // The vault is the order context's OWN ata, not the user's.
    expect(call.accounts?.orderPdaTokenAccount).not.toBe(call.accounts?.userTokenAccount);
  });

  test("rejects when the connected wallet is not the order's user", async () => {
    // `open` debits the user's ATA under the user's signature, so a different
    // wallet builds a transaction that cannot succeed.
    const order = makeOrder();
    const { deps } = makeDeps({ signerPublicKey: USER });
    await expect(openEscrow(deps, { order, orderId: ORDER_ID })).rejects.toThrow(
      /is not the order's user/
    );
  });

  test("rejects a native-SOL input with an explanation", async () => {
    const order = makeOrder({ inputs: [[0n, 1_000_000n]] });
    const user = bytes32ToPubkey(order.user as `0x${string}`).toBase58();
    const { deps } = makeDeps({ signerPublicKey: user });
    await expect(openEscrow(deps, { order, orderId: ORDER_ID })).rejects.toThrow(
      /no native-SOL input path/
    );
  });

  test("rejects a mint owned by something that is not a token program", async () => {
    const order = makeOrder();
    const user = bytes32ToPubkey(order.user as `0x${string}`).toBase58();
    const { deps } = makeDeps({
      signerPublicKey: user,
      accounts: { [MINT]: { owner: INTENTS_PROTOCOL_PROGRAM_ID } }
    });
    await expect(openEscrow(deps, { order, orderId: ORDER_ID })).rejects.toThrow(
      /not a token program/
    );
  });
});

describe("fillOutput", () => {
  test("passes fill_id and local_attestation explicitly", async () => {
    // Anchor cannot resolve either: fill_id's second seed is a hash of an
    // instruction argument, and local_attestation is created by CPI.
    const output = makeOutput();
    const { deps, calls } = makeDeps();
    await fillOutput(deps, {
      orderId: ORDER_ID,
      output,
      fillDeadline: 1_700_000_900,
      solverBytes32: b32("5")
    });

    const call = calls.find((c) => c.method === "fill")!;
    expect(call.accounts?.fillId).toBe(fillIdPda(ORDER_ID, getOutputHash(output)).toBase58());
    expect(call.accounts?.localAttestation).toBe(
      localAttestationPda(
        outputSettlerSimplePda(),
        output.oracle,
        localAttestationDataHash({ solver: b32("5"), orderId: ORDER_ID, output })
      ).toBase58()
    );
  });

  test("uses native_fill for a zero token and omits the token accounts", async () => {
    const output = makeOutput({ token: `0x${"00".repeat(32)}` as `0x${string}` });
    const { deps, calls } = makeDeps();
    await fillOutput(deps, {
      orderId: ORDER_ID,
      output,
      fillDeadline: 1_700_000_900,
      solverBytes32: b32("5")
    });

    const call = calls.find((c) => c.method === "nativeFill")!;
    expect(call).toBeDefined();
    expect(call.accounts?.mint).toBeUndefined();
    expect(calls.find((c) => c.method === "fill")).toBeUndefined();
  });

  test("encodes a JSON-round-tripped output identically to a bigint one", async () => {
    // Orders reloaded from the local DB carry `amount`/`chainId` as decimal
    // STRINGS (BigInt.prototype.toJSON on the way in, plain JSON.parse on the
    // way out). `toBytes32` used to format those with `String.prototype
    // .toString(16)`, which ignores the radix, so the decimal digits were
    // re-read as hex: amount 1000000 went out as 0x…01000000. The PDAs come
    // from `getOutputHash`, which coerces through viem and stayed correct, so
    // the program derived fill_id from a different hash than the client and the
    // fill died with ConstraintSeeds (2006) — after which the transfer would
    // have moved the wrong number of tokens.
    const output = makeOutput();
    const roundTripped = JSON.parse(
      JSON.stringify(output, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    ) as MandateOutput;
    expect(typeof (roundTripped as unknown as { amount: unknown }).amount).toBe("string");

    const bigintRun = makeDeps();
    await fillOutput(bigintRun.deps, {
      orderId: ORDER_ID,
      output,
      fillDeadline: 1_700_000_900,
      solverBytes32: b32("5")
    });
    const stringRun = makeDeps();
    await fillOutput(stringRun.deps, {
      orderId: ORDER_ID,
      output: roundTripped,
      fillDeadline: 1_700_000_900,
      solverBytes32: b32("5")
    });

    const encoded = (run: { calls: RecordedCall[] }) => {
      const call = run.calls.find((c) => c.method === "fill")!;
      return JSON.stringify({ args: call.args, accounts: call.accounts });
    };
    expect(encoded(stringRun)).toBe(encoded(bigintRun));
  });

  test("rejects a field that is not 32-byte hex before signing", async () => {
    // A base58 address reaching the instruction encoder must never be padded
    // into NaN bytes (borsh-encodes as zeroes) — that ships an argument the
    // client's own PDAs disagree with, i.e. another opaque ConstraintSeeds.
    // viem's hex parsing in `getOutputHash` is the first line of defence and
    // wins here; `bytes32Array` backstops any path that skips it.
    const { deps, sent } = makeDeps();
    await expect(
      fillOutput(deps, {
        orderId: ORDER_ID,
        output: makeOutput({ recipient: MINT as unknown as `0x${string}` }),
        fillDeadline: 1_700_000_900,
        solverBytes32: b32("5")
      })
    ).rejects.toThrow(/Invalid byte sequence|32-byte hex/);
    expect(sent).toHaveLength(0);
  });

  test("rejects a zero solver before signing", async () => {
    const { deps, sent } = makeDeps();
    await expect(
      fillOutput(deps, {
        orderId: ORDER_ID,
        output: makeOutput(),
        fillDeadline: 1,
        solverBytes32: `0x${"00".repeat(32)}` as `0x${string}`
      })
    ).rejects.toThrow(/zero pubkey/);
    expect(sent).toHaveLength(0);
  });

  test("rejects an amount above u64 before signing", async () => {
    const { deps, sent } = makeDeps();
    await expect(
      fillOutput(deps, {
        orderId: ORDER_ID,
        output: makeOutput({ amount: 1n << 64n }),
        fillDeadline: 1,
        solverBytes32: b32("5")
      })
    ).rejects.toThrow(/exceeds u64/);
    expect(sent).toHaveLength(0);
  });
});

describe("submitFillProof", () => {
  test("rejects an output whose oracle is not the polymer program", async () => {
    // This is the failure the whole PR exists to prevent: the fill succeeds,
    // then proving is impossible. Surface it as a sentence.
    const { deps, sent } = makeDeps();
    await expect(
      submitFillProof(deps, {
        orderId: ORDER_ID,
        output: makeOutput(),
        solverBytes32: b32("5"),
        timestamp: 1_700_000_000
      })
    ).rejects.toThrow(/Polymer can only prove outputs whose oracle is the Polymer program/);
    expect(sent).toHaveLength(0);
  });

  test("submits with the attestation as a remaining account", async () => {
    const withPolymerOracle = makeOutput({
      oracle: "0x050cae5588f8d907500199177ab1239f61b8557af2ffacd5defed0070b858ad4"
    });
    const { deps, calls } = makeDeps();
    await submitFillProof(deps, {
      orderId: ORDER_ID,
      output: withPolymerOracle,
      solverBytes32: b32("5"),
      timestamp: 1_700_000_000
    });

    const call = calls.find((c) => c.method === "submit")!;
    expect(call.remaining).toHaveLength(1);
    expect(call.remaining?.[0]?.pubkey).toBe(
      localAttestationPda(
        outputSettlerSimplePda(),
        withPolymerOracle.oracle,
        localAttestationDataHash({
          solver: b32("5"),
          orderId: ORDER_ID,
          output: withPolymerOracle
        })
      ).toBase58()
    );
  });
});

describe("finalise", () => {
  const solver = pubkeyToBytes32(bytes32ToPubkey(b32("5")));
  const solverBase58 = bytes32ToPubkey(solver).toBase58();
  const timestamp = 1_700_000_000;
  const sponsor = bytes32ToPubkey(b32("7")).toBase58();
  const rentRecipient = bytes32ToPubkey(b32("9")).toBase58();
  const ownOutput = () =>
    makeOutput({
      oracle: pubkeyToBytes32(new PublicKey(INPUT_SETTLER_ESCROW_PROGRAM_ID))
    });

  function localAccount(
    output: MandateOutput,
    opts: {
      timestamp?: number;
      consumed?: number;
      owner?: string;
      length?: number;
    } = {}
  ) {
    const address = localAttestationPda(
      outputSettlerSimplePda(),
      output.oracle,
      localAttestationDataHash({ solver, orderId: ORDER_ID, output })
    ).toBase58();
    const data = new Uint8Array(opts.length ?? 46);
    data.set(LOCAL_ATTESTATION_DISCRIMINATOR);
    new DataView(data.buffer).setUint32(8, opts.timestamp ?? timestamp, true);
    if (data.length === 46) {
      data.set(new PublicKey(rentRecipient).toBytes(), 13);
      data[45] = opts.consumed ?? 0;
    }
    return { [address]: { owner: opts.owner ?? INTENTS_PROTOCOL_PROGRAM_ID, data } };
  }

  function fixture(
    order: StandardSolana,
    extra: {
      accounts?: Record<string, { owner: string; data?: Uint8Array }>;
      wallet?: string;
      tokenProgram?: string;
    } = {}
  ) {
    const user = bytes32ToPubkey(order.user as `0x${string}`).toBase58();
    const result = makeDeps({
      signerPublicKey: extra.wallet ?? solverBase58,
      accounts: {
        [MINT]: { owner: extra.tokenProgram ?? TOKEN_PROGRAM_ID },
        [orderContextPda(ORDER_ID).toBase58()]: {
          owner: INPUT_SETTLER_ESCROW_PROGRAM_ID,
          data: orderContextData({ inputToken: MINT, user, sponsor })
        },
        ...extra.accounts
      }
    });
    // Build with the real upgraded IDL: assertions below observe the actual
    // serialized instruction that would be sent, not mocked builder echoes.
    // No app read factory here: its browser-only guard is deliberately retained.
    // Anchor only builds fully supplied accounts against this inert connection.
    const provider = new AnchorProvider(
      new Connection("https://finalise-tests.invalid"),
      {
        publicKey: new PublicKey(extra.wallet ?? solverBase58),
        signTransaction: async () => {
          throw new Error("Fixture provider must not sign");
        },
        signAllTransactions: async () => {
          throw new Error("Fixture provider must not sign");
        }
      },
      { commitment: "confirmed" }
    );
    const program = new Program(INPUT_SETTLER_ESCROW_IDL as Idl, provider);
    result.deps.programs.inputSettlerEscrow = {
      programId: program.programId.toBase58(),
      methods: {
        finalise(...params: unknown[]) {
          const builder = program.methods.finalise!(...params);
          const facade: SolanaInstructionBuilder = {
            accounts(accounts) {
              builder.accountsStrict(
                Object.fromEntries(
                  Object.entries(accounts).map(([name, address]) => [name, new PublicKey(address)])
                )
              );
              return facade;
            },
            remainingAccounts(accounts) {
              builder.remainingAccounts(
                accounts.map((account) => ({
                  ...account,
                  pubkey: new PublicKey(account.pubkey)
                }))
              );
              return facade;
            },
            async instruction() {
              const instruction = await builder.instruction();
              return {
                programId: instruction.programId.toBase58(),
                keys: instruction.keys.map((key) => ({
                  pubkey: key.pubkey.toBase58(),
                  isSigner: key.isSigner,
                  isWritable: key.isWritable
                })),
                data: new Uint8Array(instruction.data)
              };
            }
          };
          return facade;
        }
      }
    };
    return result;
  }

  function args(order: StandardSolana) {
    return {
      order,
      orderId: ORDER_ID,
      solveParams: order.outputs.map(() => ({ solver, timestamp })),
      destinationBytes32: solver
    };
  }

  test.each([0, 1, 3])("rejects %i solves for two outputs before sending", async (count) => {
    const order = makeOrder({ outputs: [makeOutput(), makeOutput({ amount: 2n })] });
    const { deps, sent } = await fixture(order);
    await expect(
      finalise(deps, {
        ...args(order),
        solveParams: Array.from({ length: count }, () => ({ solver, timestamp }))
      })
    ).rejects.toThrow("exactly one solve param per output");
    expect(sent).toHaveLength(0);
  });

  test("refuses a wallet that is not the original first solver", async () => {
    const order = makeOrder();
    const { deps, sent } = await fixture(order, { wallet: USER });
    await expect(finalise(deps, args(order))).rejects.toThrow("must be signed by the first solver");
    expect(sent).toHaveLength(0);
  });

  test("refuses a missing escrow before sending", async () => {
    const order = makeOrder();
    const { deps, sent } = makeDeps({ signerPublicKey: solverBase58 });
    await expect(finalise(deps, args(order))).rejects.toThrow("no open escrow");
    expect(sent).toHaveLength(0);
  });

  test.each([
    ["consumed", { consumed: 1 }],
    ["timestamp", { timestamp: timestamp + 1 }],
    ["owned", { owner: INPUT_SETTLER_ESCROW_PROGRAM_ID }],
    ["legacy", { length: 13 }]
  ] as const)("rejects an invalid consumable local account: %s", async (reason, options) => {
    const output = ownOutput();
    const order = makeOrder({ outputs: [output] });
    const { deps, sent } = await fixture(order, { accounts: localAccount(output, options) });
    await expect(finalise(deps, args(order))).rejects.toThrow(reason);
    expect(sent).toHaveLength(0);
  });

  test("rejects an absent consumable local account before sending", async () => {
    const order = makeOrder({ outputs: [ownOutput()] });
    const { deps, sent } = await fixture(order);
    await expect(finalise(deps, args(order))).rejects.toThrow("absent");
    expect(sent).toHaveLength(0);
  });

  test("consumes only escrow-owned local fills and preserves ordered remote/foreign proof slots", async () => {
    const local = ownOutput();
    const remote = makeOutput({ chainId: 8453n, amount: 2n });
    const foreign = makeOutput({ amount: 3n });
    const order = makeOrder({ outputs: [remote, local, foreign] });
    const { deps, sent } = await fixture(order, { accounts: localAccount(local) });
    await finalise(deps, args(order));
    const instruction = sent[0]![0]!;
    const remaining = instruction.keys.slice(-6);
    expect(remaining[0]!.pubkey).toBe(
      attestationPda(
        bytes32ToPubkey(order.inputOracle),
        remote.chainId,
        remote.oracle,
        remote.settler,
        fillPayloadHash({ solver, orderId: ORDER_ID, timestamp, output: remote })
      ).toBase58()
    );
    expect(remaining[1]!.pubkey).toBe(Object.keys(localAccount(local))[0]!);
    expect(remaining[2]!.pubkey).toBe(
      localAttestationPda(
        outputSettlerSimplePda(),
        foreign.oracle,
        localAttestationDataHash({ solver, orderId: ORDER_ID, output: foreign })
      ).toBase58()
    );
    expect(remaining.map((key) => key.isWritable)).toEqual([
      false,
      true,
      false,
      false,
      true,
      false
    ]);
    expect(remaining.slice(3).map((key) => key.pubkey)).toEqual([
      solverBase58,
      rentRecipient,
      solverBase58
    ]);
  });

  test.each([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID])(
    "preserves signed input mint, original solvers and designated payout using %s",
    async (tokenProgram) => {
      const order = makeOrder({ outputs: [makeOutput(), makeOutput({ chainId: 8453n })] });
      const destination = bytes32ToPubkey(b32("a")).toBase58();
      const secondSolver = b32("b");
      const { deps, sent } = await fixture(order, { tokenProgram });
      await finalise(deps, {
        ...args(order),
        destinationBytes32: pubkeyToBytes32(new PublicKey(destination)),
        solveParams: [
          { solver, timestamp },
          { solver: secondSolver, timestamp: timestamp + 1 }
        ]
      });
      const instruction = sent[0]![0]!;
      // These are protocol payout roles, not a snapshot of incidental account order.
      expect(instruction.keys[0]!.pubkey).toBe(solverBase58);
      expect(instruction.keys[2]!.pubkey).toBe(
        bytes32ToPubkey(order.user as `0x${string}`).toBase58()
      );
      expect(instruction.keys[3]!.pubkey).toBe(sponsor);
      expect(instruction.keys[4]!.pubkey).toBe(destination);
      expect(instruction.keys[5]!.pubkey).toBe(
        associatedTokenAddress(MINT, destination, tokenProgram).toBase58()
      );
      expect(instruction.keys[8]!.pubkey).toBe(MINT);
      expect(instruction.keys.some((key) => key.pubkey === tokenProgram)).toBe(true);
      const decoded = new BorshInstructionCoder(INPUT_SETTLER_ESCROW_IDL as Idl).decode(
        Buffer.from(instruction.data)
      )!;
      const data = decoded.data as {
        order: { input: { token: PublicKey; amount: { toString(): string } } };
        solve_params: { solver: number[]; timestamp: number }[];
      };
      expect(data.order.input.token.toBase58()).toBe(MINT);
      expect(data.order.input.amount.toString()).toBe("1000000");
      expect(data.solve_params.map((param) => Buffer.from(param.solver).toString("hex"))).toEqual([
        solver.slice(2),
        secondSolver.slice(2)
      ]);
      expect(data.solve_params.map((param) => param.timestamp)).toEqual([timestamp, timestamp + 1]);
    }
  );
});

describe("fillOutputs batching", () => {
  test("sends every output in ONE transaction", async () => {
    // Each output needs its own instruction, but they must share a
    // transaction: the caller stores one reference per output and later
    // searches that transaction's logs for each output's OutputFilledEvent.
    // Separate transactions leave outputs 2..N filled but unprovable.
    const outputs = [makeOutput(), makeOutput({ amount: 2_000_000n })];
    const { deps, calls, sent } = makeDeps();

    const signature = await fillOutputs(deps, {
      orderId: ORDER_ID,
      outputs,
      fillDeadline: 1_700_000_900,
      solverBytes32: b32("5")
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    expect(signature).toBe("sig1");
    expect(calls.filter((c) => c.method === "fill")).toHaveLength(2);
  });

  test("derives a distinct fill_id per output", async () => {
    const outputs = [makeOutput(), makeOutput({ amount: 2_000_000n })];
    const { deps, calls } = makeDeps();
    await fillOutputs(deps, {
      orderId: ORDER_ID,
      outputs,
      fillDeadline: 1,
      solverBytes32: b32("5")
    });
    const fills = calls.filter((c) => c.method === "fill");
    expect(fills[0]!.accounts?.fillId).not.toBe(fills[1]!.accounts?.fillId);
  });

  test("rejects an empty output list", async () => {
    const { deps } = makeDeps();
    await expect(
      fillOutputs(deps, {
        orderId: ORDER_ID,
        outputs: [],
        fillDeadline: 1,
        solverBytes32: b32("5")
      })
    ).rejects.toThrow("at least one output");
  });

  test("fillOutput is the single-output case of fillOutputs", async () => {
    const { deps, sent } = makeDeps();
    await fillOutput(deps, {
      orderId: ORDER_ID,
      output: makeOutput(),
      fillDeadline: 1,
      solverBytes32: b32("5")
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
  });
});

describe("refund paths", () => {
  const sponsor = bytes32ToPubkey(b32("7")).toBase58();
  const order = makeOrder({ outputs: [makeOutput({ chainId: 8453n })] });
  const user = bytes32ToPubkey(order.user as `0x${string}`).toBase58();
  const context = orderContextPda(ORDER_ID).toBase58();
  const accounts = {
    [MINT]: { owner: TOKEN_PROGRAM_ID },
    [context]: {
      owner: INPUT_SETTLER_ESCROW_PROGRAM_ID,
      data: orderContextData({ inputToken: MINT, user, sponsor })
    }
  };

  test("refund prepends the user's ATA and pays the stored sponsor", async () => {
    const { deps, calls, sent } = makeDeps({ accounts });
    await refund(deps, { order, orderId: ORDER_ID });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("refund");
    expect(calls[0]!.accounts).toMatchObject({
      signer: USER,
      user,
      sponsor,
      orderContext: context,
      mint: MINT,
      tokenProgram: TOKEN_PROGRAM_ID
    });
    expect(sent[0]).toHaveLength(2);
    expect(sent[0]![0]!.programId).toBe(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(sent[0]![0]!.keys[2]!.pubkey).toBe(user);
  });

  test("refund refuses a closed escrow", () => {
    const { deps } = makeDeps();
    return expect(refund(deps, { order, orderId: ORDER_ID })).rejects.toThrow("no open escrow");
  });

  test("refundOnNonFill names the attestation the input oracle wrote", async () => {
    const { deps, sent } = makeDeps({ accounts });
    const output = order.outputs[0]!;
    const notFilledHash = b32("c");
    await refundOnNonFill(deps, {
      order,
      orderId: ORDER_ID,
      outputIndex: 0,
      output,
      notFilledHash
    });
    const [ata, ix] = sent[0]!;
    expect(ata!.programId).toBe(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect([...ix!.data.subarray(0, 8)]).toEqual([...REFUND_ON_NON_FILL_DISCRIMINATOR]);
    expect(ix!.keys[2]!.pubkey).toBe(sponsor);
    expect(ix!.keys[13]!.pubkey).toBe(
      attestationPda(
        bytes32ToPubkey(order.inputOracle),
        output.chainId,
        output.oracle,
        output.settler,
        notFilledHash
      ).toBase58()
    );
  });
});

describe("recordNotFilled", () => {
  const fillDeadline = 1_700_000_900;
  const output = makeOutput({ oracle: pubkeyToBytes32(new PublicKey(POLYMER_PROGRAM_ID)) });
  const args = { orderId: ORDER_ID, output, fillDeadline };
  const localPda = localAttestationPda(
    outputSettlerSimplePda(),
    output.oracle,
    getNotFilledDescriptionHash(args)
  ).toBase58();
  const fillId = fillIdPda(ORDER_ID, getOutputHash(output)).toBase58();
  const payerOfRecord = bytes32ToPubkey(b32("9"));
  const local = (consumed: number) => {
    const data = new Uint8Array(46);
    data.set(LOCAL_ATTESTATION_DISCRIMINATOR);
    new DataView(data.buffer).setUint32(8, fillDeadline, true);
    data.set(payerOfRecord.toBytes(), 13);
    data[45] = consumed;
    return { [localPda]: { owner: INTENTS_PROTOCOL_PROGRAM_ID, data } };
  };
  const chainTime = fillDeadline + 100;

  test("absent: attest + submit_consume in one tx, rent back to the signer", async () => {
    const { deps, sent } = makeDeps({ accounts: {}, chainTime });
    await recordNotFilled(deps, { ...args, nowSecs: chainTime });
    expect(sent).toHaveLength(1);
    const [attest, consume] = sent[0]!;
    expect([...attest!.data.subarray(0, 8)]).toEqual([...ATTEST_NOT_FILLED_DISCRIMINATOR]);
    expect([...consume!.data.subarray(0, 8)]).toEqual([...SUBMIT_CONSUME_DISCRIMINATOR]);
    expect(consume!.keys[5]!.pubkey).toBe(USER);
  });

  test("current: only submit_consume, refunding the stored payer", async () => {
    const { deps, sent } = makeDeps({ accounts: local(0), chainTime });
    await recordNotFilled(deps, { ...args, nowSecs: chainTime });
    expect(sent[0]).toHaveLength(1);
    expect(sent[0]![0]!.keys[5]!.pubkey).toBe(payerOfRecord.toBase58());
  });

  test("current is allowed past the mint window (nothing is minted)", async () => {
    const late = fillDeadline + 172_800;
    const { deps, sent } = makeDeps({ accounts: local(0), chainTime: late });
    await recordNotFilled(deps, { ...args, nowSecs: late });
    expect(sent).toHaveLength(1);
  });

  test("consumed: refuses", () => {
    const { deps } = makeDeps({ accounts: local(1), chainTime });
    return expect(recordNotFilled(deps, { ...args, nowSecs: chainTime })).rejects.toThrow(
      "unusable state"
    );
  });

  test("absent past the mint window margin: refuses", async () => {
    const edge = fillDeadline + 172_800 - 600;
    const ok = makeDeps({ accounts: {}, chainTime: edge });
    await recordNotFilled(ok.deps, { ...args, nowSecs: edge });
    expect(ok.sent).toHaveLength(1);
    const late = makeDeps({ accounts: {}, chainTime: edge + 1 });
    await expect(recordNotFilled(late.deps, { ...args, nowSecs: edge + 1 })).rejects.toThrow("48h");
    expect(late.sent).toHaveLength(0);
  });

  test("local clock ahead of the window uses the later of the two clocks", () => {
    const edge = fillDeadline + 172_800 - 600;
    const { deps } = makeDeps({ accounts: {}, chainTime: edge - 100 });
    return expect(recordNotFilled(deps, { ...args, nowSecs: edge + 1 })).rejects.toThrow("48h");
  });

  test("chain time unavailable or stale: refuses", async () => {
    const none = makeDeps({ accounts: {} });
    await expect(recordNotFilled(none.deps, { ...args, nowSecs: chainTime })).rejects.toThrow(
      "Solana time unavailable"
    );
    const stale = makeDeps({ accounts: {}, chainTime });
    await expect(
      recordNotFilled(stale.deps, { ...args, nowSecs: chainTime + 601 })
    ).rejects.toThrow("Solana time unavailable");
  });

  test("chain not past the fill deadline: refuses", () => {
    const { deps } = makeDeps({ accounts: {}, chainTime: fillDeadline });
    return expect(recordNotFilled(deps, { ...args, nowSecs: fillDeadline })).rejects.toThrow(
      "fill deadline"
    );
  });

  test("filled output: refuses", async () => {
    const { deps, sent } = makeDeps({
      accounts: { [fillId]: { owner: OUTPUT_SETTLER_SIMPLE_PROGRAM_ID } },
      chainTime
    });
    await expect(recordNotFilled(deps, { ...args, nowSecs: chainTime })).rejects.toThrow("filled");
    expect(sent).toHaveLength(0);
  });
});

describe("receiveProof", () => {
  const output = makeOutput({ chainId: 8453n });
  const payloadHash = b32("d");
  const attestation = attestationPda(
    polymerOraclePda(),
    output.chainId,
    output.oracle,
    output.settler,
    payloadHash
  ).toBase58();
  const prover = { cache: USER, result: USER, internal: USER };

  test("derives the attestation from the given payload hash", async () => {
    const { deps, calls, sent } = makeDeps({ accounts: {} });
    const result = await receiveProof(deps, {
      proof: new Uint8Array([1]),
      output,
      payloadHash,
      proverProgramId: USER,
      proverAccounts: prover
    });
    expect(result.attestation).toBe(attestation);
    expect(calls.map((c) => c.method)).toEqual(["receiveLoadProof", "receiveAttest"]);
    expect(calls[1]!.accounts!.attestation).toBe(attestation);
    expect(sent).toHaveLength(2);
  });

  test("no-op when that attestation already exists", async () => {
    const { deps, sent } = makeDeps({
      accounts: { [attestation]: { owner: INTENTS_PROTOCOL_PROGRAM_ID } }
    });
    const result = await receiveProof(deps, {
      proof: new Uint8Array([1]),
      output,
      payloadHash,
      proverProgramId: USER,
      proverAccounts: prover
    });
    expect(result).toEqual({ attestation });
    expect(sent).toHaveLength(0);
  });
});
