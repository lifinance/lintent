# Solana preflight

Deployment and RPC-semantics record for the Solana integration, mirroring
`tests/fixtures/tron/PREFLIGHT.md`. Code comments cite this file by name.

Source of truth: `catalyst-intent-svm` @ `291e1da4e9a7d5f0a5ba27f07fca32e82cdae4db`
(2026-08-13). Program ids read from the **top-level `address`** of each
`target/idl/*.json` — Anchor ≥ 0.30 moved it out of `metadata`, which now holds
only `name`/`version`/`spec`. Reading `metadata.address` yields `undefined` and
derives every PDA under a garbage program id.

---

## ⚠️ Three different values are all called "the Solana Polymer oracle"

**This is the single most likely source of a silent failure.** Getting it wrong
produces an order that fills — moving the solver's tokens — and can then never
be proven.

| Field                                                    | Must hold              | Value                                                           | Proof                                                                                                                                                    |
| -------------------------------------------------------- | ---------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MandateOutput.settler` (Solana output)                  | output settler **PDA** | `DHShHmVkTwCzUzAQbCu4GDqJmursuDscNR6o4hTBgeRy` / `0xb68296ce…`  | `programs/outputs/output_settler_base/src/base.rs:122`                                                                                                   |
| `MandateOutput.oracle` (Solana output, cross-chain)      | polymer **PROGRAM ID** | `LiFiBtfyPT1DnTHTAeZ2rwr5RgMrThwA5kt7KGT5nBV` / `0x050cae5588…` | `programs/oracles/oracle_polymer/src/instructions/submit.rs:71` — compares the LocalAttestation consumer against `ctx.program_id`                        |
| `StandardSolana.inputOracle` (Solana input, cross-chain) | polymer oracle **PDA** | `49zLKETMq34CUC2E2wL1xvv6uN2AUgyhjVX221mjE3Rw` / `0x2ee088ac…`  | `oracle_polymer/src/instructions/receive_attest.rs:142` + `programs/inputs/input_settler_base/src/base.rs:125`                                           |
| Same-chain Solana→Solana, both oracle fields             | output settler **PDA** | `0xb68296ce…`                                                   | `input_settler_base/src/base.rs:88-111` — the LocalAttestation branch never reads `input_oracle`; this is canonical encoding, not a contract requirement |

The EVM rule "`output.oracle` = the input chain's oracle" holds only because
`PolymerOracle` is CREATE2-identical across EVM chains. It does **not** carry
over to Solana.

---

## Programs (identical on devnet and mainnet)

`Anchor.toml` declares the same ids under `[programs.devnet]` and
`[programs.mainnet]`, so PDAs derived from them are cluster-independent.

| Program                            | Base58                                        | bytes32                                                              |
| ---------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| `intents_protocol`                 | `LiFixdGLT5CMdLsHBvaijTXpPy4Uux9Y53SXkuR4HaK` | `0x050cae668656471e02181ee1e6c52ee00a779ca7c481a04fb0e2ab9085f5c304` |
| `input_settler_escrow`             | `LiFiRp8RM7nJUZyUYC9FPPpDr7sAy5XPfBN6ABzBgT7` | `0x050cae5ad286a6a6227a55fd650d63a3eccc866d6c293c94b87839e5cb6dba86` |
| `output_settler_simple`            | `LiFiEDFjz5x1jJe9gSXNDHQW4dWt4yLXdp2VN4EiQUt` | `0x050cae566a93270d66dbfe1915b80dc06e4a80178992592b3d8f51e888d0afe5` |
| `polymer` (crate `oracle_polymer`) | `LiFiBtfyPT1DnTHTAeZ2rwr5RgMrThwA5kt7KGT5nBV` | `0x050cae5588f8d907500199177ab1239f61b8557af2ffacd5defed0070b858ad4` |

### State PDAs

| Account                      | Seed                    | Bump | Base58                                         | bytes32                                                              |
| ---------------------------- | ----------------------- | ---- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `ChainId`                    | `chain_id`              | 255  | `BkEw3WHFvJR9a5deUcwPLJ79yK3r9YGdQ61TehFXzAQ`  | `0x02c0b32f8be4a5319a95cca17bd05eba48e7195ce52f1608723b51e575457df5` |
| `InputSettlerEscrowAccount`  | `input_settler_escrow`  | 253  | `Cj3mSoPJtgi5bubC9rLz8oM1DuXoJj97RMw1uC6ev9zm` | `0xae3613f974fc9cd94682bbff7bd7f229697616c5b6fdb6e0c16d1f02607242ae` |
| `OutputSettlerSimpleAccount` | `output_settler_simple` | 255  | `DHShHmVkTwCzUzAQbCu4GDqJmursuDscNR6o4hTBgeRy` | `0xb68296ce230150bb20190a46eb26a198b05bec8fc7f0fa893d690cf531fa9e54` |
| `OraclePolymer`              | `polymer`               | 253  | `49zLKETMq34CUC2E2wL1xvv6uN2AUgyhjVX221mjE3Rw` | `0x2ee088ace4ac030d2266e50d829feeac73d1acb13e5825ef835d6f3318804796` |

Derivation is re-verified from `(program id, seed, bump)` in `@lifi/intent`'s
`constants.spec.ts` and again app-side in `tests/unit/solanaPda.test.ts`, so
these are computed values rather than magic constants.

**Superseded — must never reappear.** `catalyst-intent-svm` commit `21fc982`
rotated every program id to the `LiFi…` vanity keys. The PDAs under the old
ids are correctly shaped and correctly derived, which is why they survived two
`@lifi/intent` releases unnoticed:
`0x0cb3931fa2bfb2296eb48e6f431df4ab41dc084c068b39f7e1f125604252611c`
(input settler) and
`0x57e93c230b75ab3ad76e89157ae3ce486fbe4ae4c4ac120882ccf2fdfb88a8bf`
(output settler).

### Order-scoped PDAs

- `order_context` = `["order_context", orderId]` — closed by `finalise` **and** by `refund`
- `consumed_order` = `["consumed_order", orderId]` — created at open, never closed (replay guard)
- `fill_id` = `[orderId, mandateOutputHash]` — **no string prefix**
- `local_attestation` = `["local_attestation", attestator, consumer, dataHash]`
- `attestation` = `["attestation", oraclePda, chainId u128 LE, source, application, payloadHash]`

---

## Hashes

| Value                                   | Preimage                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mandate_output_hash` (the FillId seed) | Byte-identical to `getOutputHash()` in `@lifi/intent`. **Reuse it; do not reimplement.** Verified in `tests/unit/solanaEncode.test.ts`.                      |
| LocalAttestation `data_hash`            | Fill description **WITHOUT** the timestamp — it is a PDA seed, so it must be derivable before the fill lands. The program verifies the timestamp separately. |
| Remote Attestation `payload_hash`       | Fill description **WITH** the timestamp.                                                                                                                     |

`FILL_MAGIC = 0xd1252dff`, `NOT_FILLED_MAGIC = 0x830c1e1c`
(`common/src/encoding/mandate_output_encoding_lib.rs`). Conflating the two fill
descriptions derives an attestation account that never exists.

---

## Events

Anchor `emit!` compiles to `sol_log_data`: a single `Program data: <base64>`
line carrying `discriminator(8) || borsh(event)`, emitted inside the emitting
program's own invoke frame. **Not** `emit_cpi!`; there is no event-authority
PDA and no self-CPI.

**Any program can print a `Program data:` line**, so frame attribution —
tracking `Program <id> invoke [n]` / `success` nesting — is the anti-spoof, not
a nicety. `findOutputFilledLog` in `src/lib/solana/events.ts` implements it and
`tests/unit/solanaEvents.test.ts` includes a forged event that must be rejected.

**None of these events appear in the generated IDLs.** They are defined in the
helper crates (`output_settler_base`, `input_settler_base`, `oracle_base`)
rather than inside a `#[program]` module, so `anchor build` omits them —
`output_settler_simple.json` ships `"events": []`. Layouts are hand-rolled.

| Event                  | Discriminator = `sha256("event:<Name>")[..8]` |
| ---------------------- | --------------------------------------------- |
| `OutputFilledEvent`    | `[43,25,133,52,107,176,40,213]`               |
| `OutputNotFilledEvent` | `[162,22,108,52,116,186,115,37]`              |
| `OpenEvent`            | `[13,191,79,145,65,183,42,90]`                |
| `FinalisedEvent`       | `[226,131,196,252,105,222,23,210]`            |
| `OutputProvenEvent`    | `[85,190,185,8,90,48,3,214]`                  |

`OutputFilledEvent` layout: `settler Pubkey(32)`, `order_id [u8;32]`,
`solver [u8;32]`, `timestamp u32 LE`, `output MandateOutput` (six `[u8;32]`
then two u32-LE-length-prefixed `Vec<u8>`), `final_amount u64 LE`.

`oracle_polymer::submit` does **not** emit an event — it writes a plain `msg!`:
`Prove: program: {program_id}, {base64(source ‖ payload)}`. That log line is
what Polymer's indexer scrapes.

---

## Instruction gotchas

- **`fill_id` must be passed explicitly.** Not a general Anchor limitation: the
  IDL can only express the second seed as the raw `output` argument, not as
  `get_mandate_output_hash(output)`. `local_attestation` is likewise created by
  CPI and must be derived client-side.
- **`open` has no native-SOL input path.** It requires an SPL mint, so an order
  depositing SOL must use wrapped SOL. Native outputs _are_ supported, via
  `native_fill` (zero token address).
- **There is no single `receive` instruction.** It is
  `receive_load_proof` + `receive_attest`, with a chunked fallback
  (`create_polymer_accounts` → `load_proof_chunk*` → `validate_event` →
  `receive_attest`) for proofs too large for one transaction
  (`oracle_polymer/src/lib.rs:14`).
- **`finalise` takes one attestation per output in `order.outputs` order** as
  remaining accounts. The program indexes them positionally, so a reordering
  settles the wrong output.
- **`filler_data` must be exactly 32 non-zero bytes** (`resolve_output.rs`).
- **No `orderStatus` enum.** `finalise` and `refund` both close
  `order_context`, so "context gone, `consumed_order` present" means terminal,
  not specifically claimed. The app already folds Claimed and Refunded together
  on EVM and Tron, so this matches.
- **The mint's owning program is part of the ATA seed.** SPL and Token-2022
  produce different ATAs for the same mint, so the owner is read on chain, not
  guessed.

---

## Stale references — do not copy from these

The reference TypeScript in `catalyst-intent-svm/tests/end-to-end/` predates
several changes and will mislead:

- `shared.ts` `computeOracleAttestationPda` **omits the `"attestation"` seed
  prefix**. The correct 6-seed derivation is in
  `base-solana/receive-and-finalise/00-receive.test.ts:213`.
- `base-solana/receive-and-finalise/00-receive.test.ts:300` calls `.receive()`,
  an instruction that no longer exists.
- `open-order/00-open-order.test.ts:226` omits the `consumed_order` account.
- `chains.json` / `default_orders.json` carry pre-rotation addresses.

---

## Toolchain

`@solana/web3.js` and `@coral-xyz/anchor` **do** import cleanly under
`bun test` — unlike `tronweb`, which cannot load under bun and is the reason
the Tron tests mock `TronWebLike`. The Solana facade still uses a DI seam
(`src/lib/solana/types.ts`), but for a different reason: isolating the signer
so write paths can be asserted without a network or a wallet.

The wallet adapters require a global `Buffer`, installed in
`src/hooks.client.ts`. Without it the failure is a bare "Buffer is not defined"
from inside a dependency at signing time.

---

## Verified on chain (2026-08-13, `finalized`)

Read directly from mainnet-beta and devnet RPC. These were previously
assumptions; they are now measurements.

| Fact                              | mainnet                                        | devnet                                         |
| --------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Genesis hash                      | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| `ChainId` PDA contents            | `1151111081099710` ✅                          | `1151111081099712` ✅                          |
| `OraclePolymer.chain_id`          | `1151111081099710`                             | `1151111081099712`                             |
| `OraclePolymer.polymer_prover_id` | `CdvSq48QUukYuMczgZAVNZrwcHNshBdtqrjW26sQiGPs` | same                                           |
| `OraclePolymer.owner`             | `7P94xcg7X4Xc8goZ3GW2VQDJUhiab7h7rnTfvnNShZ29` | `DED5bXSyFUL8YDFF8jZ5o7Aj7vpzhKvS8CgKw6MYHQY1` |
| `InputSettlerEscrow` PDA          | initialised, owned by `LiFiRp8RM7…`, 25 bytes  | same                                           |
| `OutputSettlerSimple` PDA         | initialised, owned by `LiFiEDFjz5…`, 25 bytes  | same                                           |
| Prover program                    | deployed, executable, BPFLoaderUpgradeable     | same                                           |

The mainnet oracle owner matches the ceremony key pinned in
`scripts/initialize_programs.ts`.

### Prover scratch PDAs — seed scheme confirmed

The prover's accounts are `["cache", authority]`, `["result", authority]` and
`["internal"]`, derived under the prover program id. `cache` and `result` are
per-authority (so concurrent solvers do not collide) and exist only during a
proof, but the `internal` singleton derives to
`4w6Lac3Yc8ZdJ7H4Nt9FS98VMt8w6DwkGRJL1h4Ww5z1`, **which exists on both
clusters owned by the prover program** — confirming the scheme. Pinned in
`tests/unit/solanaPda.test.ts`.

`readPolymerProverId` re-checks the pinned prover id against the on-chain
account before every receive. The prover belongs to Polymer, not to this
protocol, so a rotation on their side must fail loudly rather than as an
opaque CPI error mid-proof.

---

## STILL NOT VERIFIED

The remaining unknowns. Nothing below should be treated as fact until checked.

- [ ] **Deployed binary matches the audited source** — program accounts
      executable, program-data address resolved, binary hash recorded, upgrade
      authority recorded (or immutability confirmed). Matching a PDA and a
      chain id does not prove this.
- [ ] **`chain_mapping` PDAs** exist for every EVM chain offered as a
      counterpart.
- [ ] **Polymer's proof-request API shape for a Solana source.** The
      `{srcChainId, txSignature, programID}` body is inferred from a previous
      attempt (PR #47), not from Polymer documentation.
- [ ] **SPL mints and decimals** for the tokens listed in `config.ts`.
- [ ] One real devnet fill, with its full log dump saved beside this file as
      `tx-fill-devnet.json` (the analogue of Tron's
      `txinfo-fill-old-settler.json`).
- [ ] **`finalise` transaction-size headroom.** `validate_finalise_tx_size_fits`
      caps the finalise transaction, so orders above roughly three outputs are
      rejected at `open`. Measure the real limit and surface it at issuance.
