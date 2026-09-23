# Production IDL bundle

This bundle describes the five production programs at the source baseline recorded
in `provenance.json`. It corrects Anchor 0.31.1 client metadata without changing
the audited program source. The existing audit reports cover the reviewed contract
revisions; this tooling is a subsequent integration change.

## Generate and verify

From the repository root, using Node 22 or newer, Yarn 1.22.22, Anchor CLI 0.31.1,
and the repository's existing Rust toolchains:

```sh
yarn install --frozen-lockfile
yarn idl:generate
yarn idl:test
yarn idl:check
```

`idl:generate` runs `anchor idl build` with `--locked` for the five production
crates, then corrects their metadata. It does not build SBF binaries or deploy
anything. Compilation may need to download dependencies on a clean machine.
`idl:fix` applies the same corrections to existing `target/idl` files.
`idl:check` validates source fingerprints and raw inputs, and checks that this
bundle matches the expected output without rewriting files.

The raw files in `target/idl` and `target/types` remain native Anchor output.
Use this directory's JSON files and `types/` together for integrations. Running
`anchor build` alone does not refresh this bundle. Mock programs are not included.

The generated files include:

- Five program IDLs and matching camel-case TypeScript types.
- `errors.json`: first-party error catalogs and program associations.
- `provenance.json`: source revision, fingerprints, corrections, and artifact hashes.
- This guide, copied from `scripts/idl-guide.md`; edit the source guide and regenerate.

The script rejects missing or changed raw schemas, source drift, unexpected bundle
files, and unsupported error syntax before replacing this bundle. Regeneration is
deterministic and never updates its baseline automatically. Documentation-only
commits are allowed: the guard checks source content rather than the current Git
commit. A future contract or dependency change requires review of the correction
list, tests, source hashes, and raw-IDL hashes in `scripts/idl-baseline.json`.
Do not update hashes just to bypass a failed check. The protected files are listed
individually there; the reference commit is provenance, not a claim that later
source changes were audited.

## Explicit PDA accounts

Ten generated PDA expressions contained Rust hashes or method calls that Anchor's
automatic account resolver cannot execute. The corrected IDLs remove those `pda`
hints completely. All accounts, flags, instruction arguments, and runtime
constraints are preserved. Affected accounts must be supplied explicitly.

| Program        | Instructions                                                     | Account          | PDA seeds, in order                        |
| -------------- | ---------------------------------------------------------------- | ---------------- | ------------------------------------------ |
| Input settler  | `open`, `finalise`, `refund`, `refund_on_non_fill`               | `order_context`  | UTF-8 `order_context`, canonical order ID  |
| Input settler  | `open`                                                           | `consumed_order` | UTF-8 `consumed_order`, canonical order ID |
| Output settler | `attest_not_filled`                                              | `fill_id`        | canonical order ID, canonical output hash  |
| Output settler | `fill`, `native_fill`, `fill_samechain`, `native_fill_samechain` | `fill_record`    | canonical order ID, canonical output hash  |

Use the input or output **program ID**, respectively, as the PDA derivation program.
The canonical order ID depends on where the order originated:

- **Input settler instructions** (`open`, `finalise`, `refund`, `refund_on_non_fill`)
  and the compact same-chain fills (`fill_samechain`, `native_fill_samechain`) use
  `keccak256(Borsh(StandardOrder))`: the original unexpanded order for the input
  settler, the fully expanded order for the compact path. Never hash JSON, compact
  order bytes, or a SHA-256 digest in place of this value.
- **Ordinary output fills** (`fill`, `native_fill`, `attest_not_filled`) take
  `order_id` as an instruction argument and do **not** validate it. Pass the
  origin chain's order identifier byte-for-byte, exactly as the input settler on
  that chain computed it. Only when the origin chain is this Solana input settler
  is that value the Borsh hash above; for EVM or other origins, use that chain's
  own order ID. A fill recorded under any other value cannot settle the order.

The canonical output hash is Keccak-256 over the following packed encoding:

```text
oracle[32] || settler[32] || chain_id[32] || token[32] || amount[32]
|| recipient[32] || callback_length[u16 big-endian] || callback_data
|| context_length[u16 big-endian] || context
```

`chain_id` and `amount` are their canonical 32-byte big-endian representations.
Each variable-length field must fit a u16. This encoding differs from Borsh
encoding of `MandateOutput`. The authoritative implementation is
`common/src/encoding/mandate_output_encoding_lib.rs`.

> **Warning:** Compact same-chain fills must execute after a matching
> `finalise_with_prefill` in the same transaction. They do not create a
> `LocalAttestation`. Never submit them independently or substitute them for
> ordinary attested fills.

Required instruction order, all in one transaction:

```text
finalise_with_prefill(orderId) -> fill_samechain(args)
OR
finalise_with_prefill(orderId) -> native_fill_samechain(args)
```

`finalise_with_prefill` checks for a matching future compact fill and binds the
supplied order ID to the expanded order before releasing the input escrow. The
compact fill handlers do not enforce a preceding settlement instruction
themselves. A standalone compact fill can pay the output while producing an
unclaimable fill, without the proof needed for ordinary later finalisation.

For compact same-chain fills, expand the output exactly as
`CompactSamechainOrder::expand_output` does: oracle and settler are the output
settler **state PDA**, chain ID comes from that state, token is the mint (or 32 zero
bytes for native SOL), amount is `output_amount`, recipient comes from the account,
and callback data is empty. Context is empty for `None`, or
`0xe0 || exclusive_for[32] || start_time[u32 big-endian]`; `ExclusiveForSelf` uses
the filler for `exclusive_for`. Use the supplied canonical `args.orderId` for the
first fill-record seed; the binding checks run during the preceding
`finalise_with_prefill` described above.

Example using the corrected input-settler IDL and a typed, canonical `order`:

```ts
import { Program, type AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import inputIdl from "./input_settler_escrow.json";
import type { InputSettlerEscrow } from "./types/input_settler_escrow";

// provider and order are supplied by your application. Bytes fields use Buffers;
// wide integer fields use BN, as required by the Anchor coder.
const program = new Program<InputSettlerEscrow>(
  inputIdl as unknown as InputSettlerEscrow,
  provider
);
const orderId = Buffer.from(
  keccak_256(program.coder.types.encode("standardOrder", order))
);
const [orderContext] = PublicKey.findProgramAddressSync(
  [Buffer.from("order_context"), orderId],
  program.programId
);
const [consumedOrder] = PublicKey.findProgramAddressSync(
  [Buffer.from("consumed_order"), orderId],
  program.programId
);
const instruction = await program.methods
  .open(order)
  .accountsStrict({
    ...allOtherOpenAccounts,
    orderContext,
    consumedOrder,
  })
  .instruction();
```

`allOtherOpenAccounts` must contain every other named account from `open`;
`accountsStrict` disables automatic resolution for the whole instruction.
Use the camel-case account and argument names from `types/`. Constructing an
instruction does not validate balances, ownership, hashes, or the on-chain state.
Enable TypeScript `strict` (or at least `strictNullChecks`) for Anchor's account
types to distinguish required accounts from optional ones.

## Remaining accounts

These accounts are appended with `.remainingAccounts(...)`, after the named
accounts. They are dynamic and therefore are not added as fixed IDL accounts.
Here, N is the output or payload count; A is an attestation; R is its stored
rent-refund recipient. Every remaining-account entry has `isSigner: false`.

| Instruction                | Required order                                           | Permissions and signing                                                                                                                        |
| -------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Input `finalise`           | Exactly `[A0, ..., A(N-1), R0, ..., R(N-1)]`             | Both A/R writable for local attestations committed to this input settler. Named solver signs and matches the first output's solver.            |
| Input `refund_on_non_fill` | Exactly `[A, R]` for the selected output                 | Both writable when consumed by this input settler. Named signer signs; refund remains permissionless.                                          |
| Polymer `submit`           | Exactly `[A0, ..., A(N-1)]`                              | Read-only; no refund slots or instruction signers. N must be positive.                                                                         |
| Polymer `submit_consume`   | Exactly `[A0, R0, ..., A(N-1), R(N-1)]`                  | Both writable. N positive. Named submitter signs and must be the recorded filler for every fill payload; not-filled proofs are permissionless. |
| Wormhole `submit`          | Exactly `[A0, R0, ..., A(N-1), R(N-1)]`                  | Both writable. N positive. Named submitter and fresh post-message account sign; no additional filler-signature requirement.                    |
| Wormhole `receive`         | Exactly `[A0, ..., A(N-1)]` in decoded VAA payload order | Writable destination attestation PDAs. Named signer funds creation. No refund slots.                                                           |

For input settlement/refunds, remote and foreign-consumer attestations are not
consumed. Their A accounts may be read-only and their R slots are required but
ignored; a read-only existing account such as the system program can occupy an
ignored slot. Never omit an ignored slot. For consumed attestations, supply the
actual stored rent recipient. Executable recipients defer reclamation but retain
the required writable account metas. Duplicate addresses retain their positions;
Solana combines privileges for repeated keys at transaction compilation.

For example, a two-payload consuming submission uses:

```ts
const remaining = [attestation0, refund0, attestation1, refund1].map(
  (pubkey) => ({
    pubkey,
    isWritable: true,
    isSigner: false,
  })
);
// Append with builder.remainingAccounts(remaining). A two-output finalise instead
// uses [attestation0, attestation1, refund0, refund1].
```

## Events and errors

Wormhole now includes `OutputProvenEvent`, already emitted by the shared oracle
code. Its discriminator and field order match Polymer's tested mirror: chain ID
as u128, then three 32-byte fields (remote identifier, application, payload hash).

The IDLs preserve their original program-local `errors` arrays. Shared errors are
available in `errors.json`, keyed by enum name; each catalog retains its Rust
source path, exact numeric codes, names, and messages. `programs` is keyed by
program ID and lists its local catalog and `sharedOrCpi` catalogs. For example,
`CommonErrors` includes 6000-6022 and `OracleBaseErrors` includes 6600-6602.

To decode a failure, first identify the actual failing program from invocation
logs, then select that program's local/shared catalogs and look up the numeric
code. Prefer an explicit Anchor error name/message in the logs when present.
Protocol CPI failures use the protocol catalog. Unknown or external program IDs
must remain unknown here, even if their numeric codes overlap. Anchor framework
and external CPI errors require their own decoders. Catalog membership does not
claim that every enum variant is reachable from every instruction.

The separate catalog is not automatically consumed by Anchor's default error
decoder. This bundle does not add an SDK or automatic hash/PDA resolution.
