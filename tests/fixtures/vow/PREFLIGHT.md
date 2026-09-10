# Vow EVM preflight

Observed 2026-09-10. Reference: [solver PR 469](https://github.com/lifinance/lifi-solver/pull/469) and the local solver follow-up configuration commits.

## Contract reads

Adapter: `0x6a5003E8c50bA0e188715532602c0f076827b2f0`.
Directory: `0x108214A3f47A99f9b4f27c7f16CC9B7136653420`.
Signer at index 1: `0xd92f7b53eD04c33c744a43071F1f76eE421D2De7`.

`eth_chainId`, deployed adapter/escrow input settler/output settler bytecode, `directory()` and `getSigner(1)` were verified on Ethereum, Arbitrum, BSC, Base and Robinhood. Arc mainnet could not be checked because this workspace has no configured Arc RPC. Configure `PUBLIC_ARC_RPC_URL` or `PUBLIC_ROUTEMESH_API_KEY` before testing Arc.

## Witness and order service

`https://witness.vav.me/chains` lists all six supported EVM chains. Its latest indexed block was null for Arbitrum, Base and Arc; Ethereum, BSC and Robinhood had indexed blocks. This is a service snapshot, not proof that a particular fill can be attested.

`https://order.li.fi/api/v1/contracts` lists active Vow deployments for all six chains. The staging catalog at `https://order-dev.li.fi/api/v1/contracts` lists the five chains other than Arc mainnet.

Explicit Vow quotes for Base USDC → Arbitrum USDC, Ethereum USDC → Robinhood USDG, and Base USDC → Arc USDC, each for 1 USDC, returned empty quote arrays in both environments. This does not establish whether the cause is route policy, inventory, pricing, or solver deployment. No live order or funded transaction was submitted.

## Complete a live canary

1. Confirm the selected source/destination RPCs and deployed contracts, and ensure the witness covers the fill chain.
2. Confirm the selected directional solver route permits `vow` and advertises that pair through `oracleCosts` (main and fallback routes have independent policies).
3. Select the appropriate order API environment, choose Vow, and inspect `intent.metadata.oracle` for both chain/address entries.
4. Obtain a nonempty quote and issue a small escrow order through the connected wallet. Record its order ID and transaction hashes.
5. For LiFi execution, let the solver fill/relay/finalise and verify the app's progress reads.
6. For manual execution, use a nonexclusive order or the eligible solver account; fill, prove with Vow, and finalise. Verify the global fill log index, directory signer and origin-chain proof receipt.
7. Reload the order and verify persisted receipts, proof status and finalisation. Do not report a successful live canary without the recorded transactions.

## Automated evidence

`bun test tests/unit/vow.test.ts tests/unit/vowConfig.test.ts tests/unit/vowRoute.test.ts` covers the captured reference envelope, signature recovery, witness validation and polling, the proxy, all 36 chain combinations, imported-order validation, and persistence revival.

`bun run test:e2e tests/e2e/vow.spec.ts` uses mocked RPC/wallet/witness responses to exercise quote races and manual fill → prove → finalise, duplicate validation requests, already-proven fills, ambiguous logs, and simulation failure. These tests do not spend funds or prove live solver readiness.
