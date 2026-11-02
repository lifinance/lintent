# Tron deployment preflight findings (2026-08-03)

Canonical contracts (../lifi-oif/deployments/tron.json), all ABI-verified against
lifi-oif Foundry artifacts (exact function-set match):

| Contract      | Base58                             | Hex                                        | Artifact                     |
| ------------- | ---------------------------------- | ------------------------------------------ | ---------------------------- |
| InputSettler  | TRV3PsTLRiWpY6sWi5UAvB7Tacb2FLtCNq | 0xaa2e58aa1a4107dc8cc7ef41b97be90b25b5b842 | `InputSettlerEscrowLIFITron` |
| OutputSettler | TLwJhhq7fExHWdJQfMnsSY7VcreipmhLRm | 0x784d4f7b6e99b22d923ec99edbe2e11b38ceac93 | `OutputSettlerSimple`        |
| PolymerOracle | TPXQkHcGwEdH4Ss8kT4cDxgXt3L4n4zSHJ | 0x94b0c01e26aff5a6a0fd767afe0e3ca0f8b34e3d | `PolymerOracleMapped`        |

Raw on-chain ABIs: `abi-*.json` (note: TronGrid strips tuple components — the
authoritative full ABIs live in `src/lib/abi/tron.ts`, generated from the
artifacts).

## Generation deltas vs the old deployment / old EVM ABIs in this repo

- `open(order)` / `openFor(order, sponsor, signature)` are **payable** (old: nonpayable).
- `fillOrderOutputs(bytes32 orderId, MandateOutput[] outputs, uint48 fillDeadline, bytes fillerData)`
  — 4th arg is **`bytes` fillerData**, not `bytes32 solver`; layout per `FillerDataLib.sol`:
  bytes 0–31 = proposed solver (bytes32). fillDeadline is **uint48** (old: uint32).
- `OutputFilled(bytes32 indexed orderId, bytes32 solver, uint32 timestamp, MandateOutput output, uint256 finalAmount)`
  — has `finalAmount`.
- `setAttestation(bytes32 orderId, bytes32 solver, uint32 timestamp, MandateOutput output)` exists
  (fills write `_fillRecords`; proving reads `_attestations` — same-chain flows must call it).
- `receiveMessage(bytes)` and `receiveMessage(bytes[])` overloads on the oracle.
- `finalise(order, SolveParams[], bytes32 destination, bytes call)`;
  `finaliseWithSignature(..., bytes orderOwnerSignature)`; `refundOnNonFill(order, outputIndex)`.
- Input settler is the Tron variant: routes USDT payouts through
  `SafeTRC20.safeTransferUSDT` (Tron USDT returns `false` on success) and pins the
  Tron Permit2 deployment.

## TronGrid semantics (verified live)

- `getTransactionInfo` log format: `address` = 20-byte hex, **unprefixed, no 41**;
  topics/data unprefixed. Success = `receipt.result === "SUCCESS"` (no top-level
  `result` key on success; failures set `result: "FAILED"` + `receipt.result` =
  REVERT/OUT_OF_ENERGY/... + hex `resMessage`). Real fixture:
  `txinfo-fill-old-settler.json` (old settler; no txs exist on the new contracts
  yet, so failure fixtures are synthesized from the documented shape).
- **JSON-RPC `logIndex` is block-global**: block 84276720 has 78 logs indexed
  0–77 monotonically; our fill log sits at position 53 == logIndex 53. The
  Polymer proof path's `globalLogIndex` assumption holds on viem-over-TronGrid.
- **Unkeyed TronWeb rejects `.call()`** with "owner_address isn't set" — read
  clients must `setAddress(<neutral>)`; we use the black-hole address
  `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`. With it, `orderStatus`, `getFillRecord`,
  `isProven`, `balanceOf`, `allowance`, `getBlockByNumber(0)`,
  `getTransactionInfo` all succeed without a key.
- Unauthenticated TronGrid 429s under modest burst — pace/caching required,
  optional `TRON-PRO-API-KEY` header hook recommended.
- Tron mainnet genesis blockID (network guard constant):
  `00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc`.
- bun cannot import `tronweb` at runtime (`ethereum-cryptography@2.2.1` pins
  `@noble/hashes@1.4.0`, whose ESM breaks under bun). Vite/node are fine. Unit
  tests must mock `TronWebLike` (DI) and never import the real package.
