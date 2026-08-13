import { beforeEach, describe, expect, test } from "bun:test";
import { SOLANA_DEVNET_CHAIN_ID, getOutputHash } from "@lifi/intent";
import type { MandateOutput, StandardSolana } from "@lifi/intent";
import {
  INPUT_SETTLER_ESCROW_PROGRAM_ID,
  INTENTS_PROTOCOL_PROGRAM_ID,
  OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
  POLYMER_PROGRAM_ID
} from "../../src/lib/idl";
import { SOLANA_GENESIS_HASHES, invalidateSolanaClusterGuard } from "../../src/lib/solana/client";
import { localAttestationDataHash } from "../../src/lib/solana/encode";
import {
  TOKEN_PROGRAM_ID,
  bytes32ToPubkey,
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
  SolanaInstructionLike,
  SolanaProgramLike,
  SolanaProgramsLike
} from "../../src/lib/solana/types";
import { fillOutput, finalise, openEscrow, submitFillProof } from "../../src/lib/solana/writes";

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
    intentsProtocol: make("intentsProtocol", INTENTS_PROTOCOL_PROGRAM_ID)
  };
}

function makeDeps(
  opts: {
    accounts?: Record<string, { owner: string; data?: Uint8Array }>;
    signerPublicKey?: string;
    genesis?: string;
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
      getLatestBlockhash: async () => ({ blockhash: "hash", lastValidBlockHeight: 1 })
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

  test("refuses when the connected wallet is not the first solver", async () => {
    const order = makeOrder();
    const { deps, sent } = makeDeps({ signerPublicKey: USER });
    await expect(
      finalise(deps, {
        order,
        orderId: ORDER_ID,
        solveParams: [{ solver, timestamp: 1_700_000_000 }],
        destinationBytes32: solver
      })
    ).rejects.toThrow(/must be signed by the first solver/);
    expect(sent).toHaveLength(0);
  });

  test("refuses when the escrow is already settled", async () => {
    const order = makeOrder();
    const { deps } = makeDeps({ signerPublicKey: solverBase58 });
    await expect(
      finalise(deps, {
        order,
        orderId: ORDER_ID,
        solveParams: [{ solver, timestamp: 1_700_000_000 }],
        destinationBytes32: solver
      })
    ).rejects.toThrow(/no open escrow/);
  });

  test("passes one attestation per output, in order.outputs order", async () => {
    // The program indexes remainingAccounts positionally, so a reordering
    // settles the wrong output.
    const outputs = [makeOutput(), makeOutput({ amount: 2_000_000n })];
    const order = makeOrder({ outputs });
    const context = orderContextPda(ORDER_ID).toBase58();
    const { deps, calls } = makeDeps({
      signerPublicKey: solverBase58,
      accounts: {
        [MINT]: { owner: TOKEN_PROGRAM_ID },
        [context]: { owner: INPUT_SETTLER_ESCROW_PROGRAM_ID, data: new Uint8Array(40) }
      }
    });

    await finalise(deps, {
      order,
      orderId: ORDER_ID,
      solveParams: [
        { solver, timestamp: 1_700_000_000 },
        { solver, timestamp: 1_700_000_001 }
      ],
      destinationBytes32: solver
    });

    const call = calls.find((c) => c.method === "finalise")!;
    expect(call.remaining).toHaveLength(2);
    // Both outputs are same-chain here, so both are LocalAttestations.
    expect(call.remaining?.[0]?.pubkey).toBe(
      localAttestationPda(
        outputSettlerSimplePda(),
        outputs[0]!.oracle,
        localAttestationDataHash({ solver, orderId: ORDER_ID, output: outputs[0]! })
      ).toBase58()
    );
    expect(call.remaining?.[1]?.pubkey).not.toBe(call.remaining?.[0]?.pubkey);
  });
});
