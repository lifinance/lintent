// The single place Anchor is imported.
//
// Reviewer feedback on the previous Solana attempt was that the provider and
// wallet boilerplate got copy-pasted into every library that needed a program.
// It lives here once, behind `SolanaProgramsLike`, so the writes layer never
// sees an `AnchorProvider`, a `PublicKey` or a `BN`.

import {
  INPUT_SETTLER_ESCROW_IDL,
  INTENTS_PROTOCOL_IDL,
  OUTPUT_SETTLER_SIMPLE_IDL,
  POLYMER_IDL
} from "$lib/idl";
import { getSolanaReads, solanaRpcUrl } from "./client";
import type {
  SolanaAccountMeta,
  SolanaInstructionBuilder,
  SolanaInstructionLike,
  SolanaProgramLike,
  SolanaProgramsLike
} from "./types";

/** Anchor's builder, narrowed to the parts the adapter touches. */
type AnchorBuilder = {
  accounts(accounts: Record<string, unknown>): AnchorBuilder;
  remainingAccounts(accounts: unknown[]): AnchorBuilder;
  instruction(): Promise<{
    programId: { toBase58(): string };
    keys: { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }[];
    data: Uint8Array;
  }>;
};

type AnchorProgram = {
  programId: { toBase58(): string };
  methods: Record<string, (...args: unknown[]) => AnchorBuilder>;
};

function adaptBuilder(
  builder: AnchorBuilder,
  toPublicKey: (address: string) => unknown
): SolanaInstructionBuilder {
  return {
    accounts(accounts) {
      const mapped = Object.fromEntries(
        Object.entries(accounts).map(([name, address]) => [name, toPublicKey(address)])
      );
      return adaptBuilder(builder.accounts(mapped), toPublicKey);
    },
    remainingAccounts(accounts) {
      const mapped = accounts.map((account) => ({
        pubkey: toPublicKey(account.pubkey),
        isSigner: account.isSigner,
        isWritable: account.isWritable
      }));
      return adaptBuilder(builder.remainingAccounts(mapped), toPublicKey);
    },
    async instruction(): Promise<SolanaInstructionLike> {
      const ix = await builder.instruction();
      return {
        programId: ix.programId.toBase58(),
        keys: ix.keys.map(
          (key): SolanaAccountMeta => ({
            pubkey: key.pubkey.toBase58(),
            isSigner: key.isSigner,
            isWritable: key.isWritable
          })
        ),
        data: new Uint8Array(ix.data)
      };
    }
  };
}

function adaptProgram(
  program: AnchorProgram,
  toPublicKey: (address: string) => unknown
): SolanaProgramLike {
  return {
    programId: program.programId.toBase58(),
    // A Proxy rather than an enumerated map: Anchor derives method names from
    // the IDL, so listing them here would be a second copy of the interface
    // that silently rots when the programs change.
    methods: new Proxy({} as Record<string, (...args: unknown[]) => SolanaInstructionBuilder>, {
      get(_target, name) {
        if (typeof name !== "string") return undefined;
        const method = program.methods[name];
        if (!method) {
          throw new Error(`Program ${program.programId.toBase58()} has no instruction "${name}"`);
        }
        return (...args: unknown[]) => adaptBuilder(method(...args), toPublicKey);
      }
    })
  };
}

const programCache = new Map<string, Promise<SolanaProgramsLike>>();

/**
 * The four programs, bound to `chainId`'s connection.
 *
 * The provider is deliberately read-only: it carries a public key so Anchor
 * can populate `signer`-flagged accounts, but its signing methods reject.
 * Signing goes through `SolanaSignerLike` instead, which keeps one path to the
 * wallet and stops a stray `.rpc()` call from bypassing the cluster guard.
 *
 * `publicKey` is optional because instruction *building* needs it only when an
 * account is derived from the signer; reads never do.
 */
export function createSolanaPrograms(args: {
  chainId: number | bigint;
  publicKey?: string;
}): Promise<SolanaProgramsLike> {
  const key = `${args.chainId}:${args.publicKey ?? "none"}`;
  const existing = programCache.get(key);
  if (existing) return existing;

  const created = (async () => {
    const [anchor, web3, reads] = await Promise.all([
      import("@coral-xyz/anchor"),
      import("@solana/web3.js"),
      getSolanaReads(args.chainId)
    ]);
    void reads;

    const { AnchorProvider, Program } = anchor;
    const { Connection, PublicKey } = web3;

    // Anchor wants a real web3.js Connection, so build one here rather than
    // trying to force the SolanaConnectionLike adapter through its API. Same
    // endpoint, so it shares the RPC configuration.
    const connection = new Connection(solanaRpcUrl(args.chainId), "confirmed");

    const rejectSigning = () => {
      throw new Error(
        "The Anchor provider does not sign. Route the instruction through SolanaSignerLike so the cluster guard runs."
      );
    };
    const wallet = {
      publicKey: args.publicKey ? new PublicKey(args.publicKey) : PublicKey.default,
      signTransaction: rejectSigning,
      signAllTransactions: rejectSigning
    };

    const provider = new AnchorProvider(connection, wallet as never, {
      commitment: "confirmed"
    });

    const toPublicKey = (address: string) => new PublicKey(address);
    const build = (idl: unknown) =>
      adaptProgram(new Program(idl as never, provider) as unknown as AnchorProgram, toPublicKey);

    return {
      inputSettlerEscrow: build(INPUT_SETTLER_ESCROW_IDL),
      outputSettlerSimple: build(OUTPUT_SETTLER_SIMPLE_IDL),
      polymer: build(POLYMER_IDL),
      intentsProtocol: build(INTENTS_PROTOCOL_IDL)
    } satisfies SolanaProgramsLike;
  })();

  created.catch(() => programCache.delete(key));
  programCache.set(key, created);
  return created;
}
