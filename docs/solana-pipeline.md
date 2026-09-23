# Solana issuance, filling, and rent recovery

The Solana client uses the corrected production interfaces from
[`lifi-intent-svm` PR #127](https://github.com/catalystsystem/lifi-intent-svm/pull/127),
including the atomic pipeline from
[#124](https://github.com/catalystsystem/lifi-intent-svm/pull/124) and account cleanup from
[#126](https://github.com/catalystsystem/lifi-intent-svm/pull/126).
The bundle was copied from commit `007288779cc3238cb928c1cede38c5462d409dc2`;
its source reference is `776773a61a6e4d25370712818d60ee6fb459947a`.

`src/lib/idl/` contains the complete upstream bundle, including generated types,
error catalogs, integration notes, and provenance. Keep these artifacts byte-for-byte
intact: `tests/unit/solanaPipeline.test.ts` checks every upstream file hash.
The app supplies all accounts explicitly through Anchor's `accountsStrict`.

## Issuing

Solana inputs use SPL or Token-2022 escrow; select wrapped SOL for SOL input.
The issuer signs `open` with their wallet. The client checks the canonical SDK
order ID, integer widths, deadlines, and the contract's conservative finalisation
size estimate before signing. Solana-input orders support one output. Solana
outputs require an empty callback and a u64 amount.

Both mainnet and devnet use this ABI. There is no legacy instruction fallback.
The existing genesis-hash check guards against a misconfigured RPC cluster.
Old account layouts produce an explicit upgrade error.

## Filling

For eligible same-chain Solana orders, **Fill and settle** is the default. It sends
`finalise_with_prefill(order_id)` followed by `fill_samechain` or
`native_fill_samechain` in one transaction. Compact fills are never offered as a
standalone operation. The transaction releases escrow and delivers the output
atomically, so a failed delivery also rolls back the release.

Eligibility requires one input, one output, the canonical input settler, local
oracle/settler addresses, no callback, and either empty context or canonical `e0`
exclusivity. The client validates the connected solver, chain clock, live order
context, and full-order hash. The compact encoding preserves the canonical
order, including exclusive-solver identity and start time.

This path performs direct transfers. Different-token or native outputs require
the solver's existing output balance; it does not insert a swap. SOL is required
for fees and rent. SPL and Token-2022 mint ownership determines ATA derivation.
Every transaction is measured against the 1,232-byte limit and simulated before
requesting the wallet signature. The supported atomic transactions fit legacy
transactions without address lookup tables.

**Fill, then prove and claim** remains available. Ordinary fills create a
`FillRecord` and a local attestation. Polymer proof submission uses the retryable,
readonly `submit` instruction. Finalisation supplies exactly `[A0…AN, R0…RN]`:
locally consumed attestations and their stored refund recipients are writable;
remote and other-consumer attestations remain readonly with placeholder refund
slots. The client rejects consumed or incompatible local attestations.

## Receipts and rent

Successful RPC receipts are persisted in the existing local receipt table, keyed
by chain and base58 signature. Fill evidence must match the output program,
order ID, output, and event. Settlement evidence must match the input program,
order ID, and order-context PDA. Atomic completion additionally matches the fill
and settlement solver. Failed transactions and arbitrary imported signatures do
not advance progress. A closed escrow alone does not establish settlement.

The app skips proof and claim after a confirmed atomic settlement. Persisted
receipts preserve this state after reload and after the proof accounts are
closed, even when the RPC no longer serves the transaction. For self-fills, the
event's `finalAmount` is the nominal filled amount, not a measured balance gain.

The final screen shows fill-record rent, its stored refund recipient, and the
reclaim time. Reclaim requires a verified fill receipt and a chain timestamp
strictly greater than stored `close_after` (fill deadline plus 48 hours). It
returns rent to the original stored filler regardless of who pays for cleanup.
Expired intents remain accessible through **View settlement and rent**.

The exact account sizes, including discriminators, are:

| Account            | Bytes | Relevant fields                             |
| ------------------ | ----- | ------------------------------------------- |
| `OrderContext`     | 105   | input mint, user, sponsor, bump             |
| `LocalAttestation` | 46    | timestamp, bump, rent refund, consumed flag |
| `FillRecord`       | 48    | rent refund, u64 close-after timestamp      |

## Verification and rollout

- `bun run check` checks Svelte and TypeScript.
- `bun run test:unit` includes real Anchor instruction/account codecs, upstream
  artifact hashes, canonical SDK order hashes, account permissions, transaction
  sizes, receipt validation, and the strict reclaim boundary.
- `bun run test:e2e tests/e2e/solana.spec.ts` exercises issuance, atomic filling,
  ordinary filling/claiming, simulation rejection, cleanup, and receipt recovery
  after reload. The browser uses the real builders, wallet adapter, and local DB
  with deterministic mocked RPC reads and broadcasts. The test fixture is served
  only by Vite's test mode and is not included in the production bundle.

Before live canaries, upgrade devnet programs to this contract revision. On
2026-09-23, read-only executable comparisons matched the four client-used mainnet
programs to the locally built artifacts; devnet differed. Repeat deployment
verification after upgrades. Browser mocks and codec checks do not execute the
programs on a validator.

Live canaries should cover SPL and Token-2022 issuance/atomic settlement, native
output, ordinary fill/proof/claim, deliberate delivery failure with unchanged
escrow state, and cleanup after the stored deadline. Record signatures and
account balances. Production deployment remains a separate step after preview
review and live validation.
