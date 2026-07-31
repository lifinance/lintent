---
name: add-chain
description: Add a new EVM chain and/or tokens to the lintent demo app (lintent.org / cat-swapper) by editing src/lib/config.ts. Use when the user wants to add a chain (display name + RPC URL), support a new network, or add select tokens for demoing the service. Handles viem-supported and non-viem chains, custom RPCs, native + ERC-20 tokens, and runs RPC/codehash/Polymer verification. Does not commit or open a PR.
---

# Add a chain / tokens to lintent

You add a new EVM chain and/or tokens to the lintent demo app. **Everything lives in
one file: `src/lib/config.ts`.** This skill carries every pointer you need — **do not
explore the repo**. Be fast and focused.

## Hard rules

- Edit **only `src/lib/config.ts`**. Do **not** edit `src/lib/utils/web3-onboard.ts` —
  wallet onboarding auto-derives chains from `chainMap` (reads `chain.name` and
  `chain.rpcUrls.default.http[0]`), which is exactly why the chain object must carry
  the user's display name + custom RPC (see Step 3).
- **No commit, no PR.** Leave the working tree edited; the user reviews.
- **Ask the user questions ONCE, up front** (Step 0), only for missing inputs. After
  that, run to completion with **no mid-flow questions** — anything unresolved gets a
  safe default plus a warning in the final summary for the user to modify.
- **One blocking gate only:** `bun run check` must pass. Every external check
  (codehash / Polymer / RouteMesh) is **non-blocking** — collect results and warn at
  the end.
- **Never print, echo, or commit secrets.** For Polymer / RouteMesh API keys, reference
  via shell variables only and prefer the local `/polymer/health` route so the key never
  touches your shell (Step 5). Also: the **RPC URL you write into `config.ts` is bundled
  into the browser client** (onboarding reads it from `chainMap`) **and committed** — it
  must be a public, demo-safe endpoint with **no embedded API key/secret**.

## Step 0 — Gather inputs (ask once, only if missing)

Typical input is a chain (or chains) plus ≥1 token, but support all three shapes:
**chain + tokens**, **tokens-only** (added to a chain already in the repo), or
**chain-only**. If anything needed below is missing, ask for it all in a **single
batched** question, then proceed.

Required, per new chain:

- **display name** (e.g. "Optimism", "Base Sepolia") — **never infer this.**
- **≥1 RPC URL** — HTTPS, ideally browser/CORS-enabled. ⚠️ It is bundled into the client
  and committed, so it must be **public/demo-safe with no API key in the URL**.
- **mainnet or testnet.**

Required, per token: the **chain** it belongs to (new or existing), and either an
**address** (ERC-20) or the literal **`native`** (the chain's gas token).

Optional (accept now to avoid asking later; otherwise defaulted + warned):

- `nativeCurrency { name, symbol, decimals }` — only used if the chain is **not** in
  viem. Default `{ name: "Ether", symbol: "ETH", decimals: 18 }`.
- a token **display alias** (used as the selector `name`) if you want to override the
  fetched symbol or resolve a same-chain name collision.

## Step 1 — Resolve each chain

1. **chainId** (inferred, authoritative):

   ```bash
   cast chain-id --rpc-url "<RPC>"
   ```

   If the user also supplied a chainId and it differs → record a warning (don't abort).

2. **Duplicate-chain guard:** if this chainId already matches an existing `chainMap`
   entry (compare against the chain objects' `.id`), **do not create a second chain
   entry.** Default to "add tokens to the existing key" mode — reuse that chainKey for
   the tokens and skip edit sites 1–4, 6–7. (If the user instead wants to change that
   chain's display name or RPC, edit its **existing** chain object + `clients` entry in
   place rather than adding a new key.)

3. **viem support detection:**

   ```bash
   bun -e "import * as c from 'viem/chains'; const m=Object.entries(c).filter(([,v])=>v&&v.id===<ID>).map(([k])=>k); console.log(JSON.stringify(m))"
   ```

   - Non-empty → the chain is in viem. Pick the **canonical** export: drop any
     `*Preconf` variants; for `id === 1` use `mainnet` (the repo aliases it as
     `ethereum`). Note all candidates in the summary if more than one.
   - `[]` → not in viem → you'll `defineChain` (Step 3, non-viem case).

4. **mainnet/testnet bucket:** if the chain is in viem, read the export's `.testnet`
   flag; **warn** if it conflicts with the user's stated mainnet/testnet. For non-viem
   chains, use the user's answer (and you **must** set `testnet: true` explicitly in
   `defineChain` for testnets — otherwise `!chainMap[c].testnet` is `!undefined ===
true` and the app treats it as mainnet).

5. **chainKey** (the camelCase repo key, also the TS union member): derive it from the
   display name — lowercase the first word, capitalize subsequent words, strip
   non-alphanumerics (e.g. "Base Sepolia" → `baseSepolia`, "Optimism" → `optimism`).
   It must be a valid JS identifier and unique. Use it **byte-identically** at all 7
   edit sites. You'll present it at the end for the user to rename.

## Step 2 — Resolve each token

- **Native** (`native`): entry is
  `{ address: ADDRESS_ZERO, name: "<symbol lowercased>", chain: "<chainKey>", decimals: <nativeDecimals> }`.
  Do **not** make RPC metadata calls for native — `ADDRESS_ZERO` has no `decimals()`.
- **ERC-20:** fetch metadata over the chain's RPC:
  ```bash
  cast call <ADDR> "decimals()(uint8)" --rpc-url "<RPC>"
  cast call <ADDR> "symbol()(string)"  --rpc-url "<RPC>"
  ```
  The repo's `name` field is a short **selector symbol** (`usdc`, `weth`, …), not the
  ERC-20 `name()`. Convention is lowercase, but it isn't strict (e.g. `vbUSDC` exists) —
  default to `symbol.toLowerCase()` or the user's alias, matching nearby entries.
- **Naming rules (UI-aware):**
  - **Unique within a chain** — `OutputTokenModal` selects by `name + chain`. On a
    same-chain collision, alias (e.g. `usdc` vs `usdc.e`).
  - **Share the symbol across chains** — `InputTokenModal` groups input tokens by
    `name` across chains, so the same asset should keep the same `name` on every chain
    (do **not** auto-alias across chains).
- **On failure** (call reverts, returns `bytes32`, or RPC unreachable): use the user's
  alias if provided, else a placeholder name derived from the address, and record a
  warning. **Do not ask mid-flow.**

## Step 3 — Apply the 7 edits to `src/lib/config.ts`

Edit sites (current line anchors; re-open the file to place edits precisely):

**Site 1 — chain object (top, near L1–23).**

_viem case_ — wrap the export so the display name + custom RPC reach `chainMap`
(prepend the custom RPC as primary, viem defaults as fallback):

```ts
import { <export> as <chainKey>Viem } from "viem/chains";
export const <chainKey> = {
  ...<chainKey>Viem,
  name: "<display name>",
  rpcUrls: {
    ...<chainKey>Viem.rpcUrls,
    default: {
      ...<chainKey>Viem.rpcUrls.default,
      http: ["<customRpc>", ...<chainKey>Viem.rpcUrls.default.http],
    },
  },
} as const;
```

(Add `<export>` to the existing `from "viem/chains"` import block. If the user gave no
custom RPC and accepts viem's display name, a bare `import { <export> as <chainKey> }`
is acceptable — but default to wrapping, since the user supplies name + rpc.)

_non-viem case_ — define it (mirror the existing `pharos` block):

```ts
export const <chainKey> = defineChain({
  id: <chainId>,
  name: "<display name>",
  nativeCurrency: { name: "<n>", symbol: "<sym>", decimals: <d> },
  rpcUrls: { default: { http: ["<customRpc>"] } },
  testnet: <true if testnet — omit/false for mainnet>,
});
```

**Site 2 — `chainMap` (L64–77):** add `<chainKey>,`.

**Site 3 — `chainList(mainnet)` (L80–84):** push `"<chainKey>"` into the **mainnet**
array (the `mainnet === true` branch) or the **testnet** array (the `else` branch).
⚠️ This returns `string[]` and is **not** type-checked — forgetting it compiles fine
but the chain won't appear in the UI. The invariant check (Step 4) guards this.

**Site 4 — `POLYMER_ORACLE` (L43–57):** add
`<chainKey>: "<bucket address>"` using the deterministic per-bucket address:

- mainnet → `0x008C3800F3Ad9b3B662d002E90Cc00000000eE17` (⚠️ `PolymerOracleMapped`; its
  `chainIdMap` must be populated by the owner before proofs validate on a given chain)
- testnet → `0xC401b53377b8A71A7cEB820e6a4dC53832343a90`

**Site 5 — `coinList(mainnet)` (L95–282):** add one object per token to the correct
branch. ERC-20 uses a backtick hex literal; native uses the bare `ADDRESS_ZERO`
constant (no quotes, no backticks):

```ts
// ERC-20:
{ address: `0x<addr>`, name: "<selector>", chain: "<chainKey>", decimals: <d> },
// native gas token:
{ address: ADDRESS_ZERO, name: "<selector>", chain: "<chainKey>", decimals: <nativeDecimals> },
```

**Site 6 — `clients` (L389–460):** add a client. Because the custom RPC is already
first in the wrapped chain object, just map over its RPC list:

```ts
<chainKey>: createPublicClient({
  chain: <chainKey>,
  transport: fallback(<chainKey>.rpcUrls.default.http.map((v) => http(v))),
}),
```

⚠️ Template off `base`/`megaeth`. **Do NOT copy the `polygon` entry** — it has a
`chain: base` copy-paste bug (L415).

**Site 7 — `polymerChainIds` (L309–322):** add `<chainKey>: <chainKey>.id,` to keep it
in sync with `chainMap`. It's an `as const` object (not a `Record<chain>`) and is
currently not read at runtime, so a missing key neither fails compile nor breaks the
demo — add it for consistency, but it's the lowest-stakes site.

(Skip `wormholeChainIds` and `WORMHOLE_ORACLE` — Wormhole is commented out in
`getOracle`, L378–381.)

## Step 4 — Invariant check + compile gate (blocking)

1. **Invariant check** (deterministic; catches the non-type-checked omissions). List
   every occurrence of your chainKey and confirm by eye that it appears in **chainMap,
   chainList (correct mainnet/testnet branch), POLYMER_ORACLE, coinList, clients,
   polymerChainIds**, and that every new token's `chain` is a real chainKey:
   ```bash
   grep -n "<chainKey>" src/lib/config.ts
   ```
   (`chainList` is the easy miss — it isn't type-checked at all — followed by `coinList`
   and `clients`.)
2. **`bun run check` — fix until it has no errors referencing your edits.** This is the
   only blocking gate (optionally also `bun run lint`).
   ⚠️ This repo can have **pre-existing, unrelated** errors — notably, if `.env` lacks
   `PRIVATE_ROUTEMESH_API_KEY` (it's in `.env.example`), `outputFilledVerify.ts` fails to
   typecheck regardless of any chain change. So **run `bun run check` once before you
   edit** to capture the baseline error set, then treat as blocking only NEW errors that
   reference `src/lib/config.ts` or your new `<chainKey>` / token entries. (Don't
   `git stash` mid-edit to baseline — it can clobber the user's other working changes.)

## Step 5 — External verification (non-blocking; collect for the summary)

Run these, record match/mismatch/absent/unsupported, but **never abort** on them.

**Infra codehash compare** — proves the protocol contracts are actually deployed on the
new chain (these are deterministic addresses reused across chains). Compare each address
on the new chain vs the reference chain (`base` mainnet / `baseSepolia` testnet):

```bash
NEW_RPC="<RPC>"
REF_RPC="https://base-rpc.publicnode.com"          # testnet: https://base-sepolia-rpc.publicnode.com
for a in \
  0x75220B7600c300005038432a0000f308e0000068 \
  0x00000000000000171ede64904551eeDF3C6C9788 \
  0x0000000000cd5f7fDEc90a03a31F79E5Fbc6A9Cf \
  0x00fC00edbe7C003b006f870068c548940000223e \
  0xb912b4c38ab54b94D45Ac001484dEBcbb519Bc2B \
  0x1fccC0807F25A58eB531a0B5b4bf3dCE88808Ed7 \
  0x008C3800F3Ad9b3B662d002E90Cc00000000eE17 ; do
  printf '%s new=%s ref=%s\n' "$a" "$(cast codehash $a --rpc-url "$NEW_RPC" 2>&1)" "$(cast codehash $a --rpc-url "$REF_RPC" 2>&1)"
done
```

(Addresses in order: COIN_FILLER, COMPACT, INPUT_SETTLER_COMPACT_LIFI,
INPUT_SETTLER_ESCROW_LIFI, MULTICHAIN_INPUT_SETTLER_ESCROW, MULTICHAIN_INPUT_SETTLER_COMPACT,
POLYMER_ORACLE-mainnet. For a testnet chain, use the testnet oracle
`0xC401b53377b8A71A7cEB820e6a4dC53832343a90` instead of the last one and `baseSepolia`
as REF.) `new == ref` → match. Codehash `0x0000…0000` or
`0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470` (empty code) →
**absent** (that path won't work on this chain).

**Polymer support.** Preferred — if `bun run dev` is running, hit the **local route** so
the key stays server-side and never touches your shell:

```bash
curl -s -X POST http://localhost:5173/polymer/health \
  -H 'Content-Type: application/json' -d '{"chainIds":[<ID>],"mainnet":true}'   # mainnet:false for testnet
```

Fallback — direct API, reading the key from `.env`. ⚠️ This passes the key as a process
argument (visible in `ps`); only on a trusted local machine, and never log/commit it:

```bash
set -a; . ./.env 2>/dev/null; set +a
URL="https://api.polymer.zone/v1/"; KEY="$PRIVATE_POLYMER_MAINNET_ZONE_API_KEY"   # testnet: api.testnet.polymer.zone/v1/ + PRIVATE_POLYMER_TESTNET_ZONE_API_KEY
curl -s -X POST "$URL" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"info_health","params":[{"chain_ids":[<ID>]}]}'
```

`status["<ID>"] == "healthy"` (local route: `failed:false`) → supported. An
`unsupported chain ID(s)` error or `"unhealthy"` → warn (Polymer cross-chain won't work yet).

**RouteMesh** (only if the key exists; it's in `.env.example` but usually not in `.env`):

```bash
set -a; . ./.env 2>/dev/null; set +a
if [ -n "$PRIVATE_ROUTEMESH_API_KEY" ]; then
  curl -s -X POST "https://lb.routeme.sh/rpc/<ID>/$PRIVATE_ROUTEMESH_API_KEY" \
    -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
else echo "RouteMesh: skipped (PRIVATE_ROUTEMESH_API_KEY not set locally)"; fi
```

A result matching `<ID>` (hex) → supported. Error/empty → warn.

**CORS:** note that the RPC must allow browser origins, or in-app and wallet reads will
fail in the running app even though `cast`/Node calls succeed.

## Step 6 — Final summary (your deliverable)

Output, concisely:

1. **What was added** — chain(s) + token(s), and the **derived `chainKey`** clearly
   marked **"rename here if you want a different key"**, plus any **defaulted** values
   (nativeCurrency, token aliases) flagged for modification.
2. **Verification table** — one row per check with ✅ / ⚠️ / ❌:
   chainId reachable & matches · `bun run check` · infra codehashes (per address:
   match/absent) · Polymer health · RouteMesh · CORS note.
3. **Caveats** — explicitly state that codehash/Polymer/RouteMesh prove _infra presence
   / external-service support_, **not** that the full issue → fill → finalise demo path
   works end-to-end; for cross-chain demos LI.FI's order server (`order.li.fi`) must
   also support the chain.
4. **Usage instructions:**
   - `bun run dev` and open the app.
   - Toggle mainnet/testnet to match the chain's bucket.
   - Select the new chain and token(s) in the input/output token modals; confirm the
     wallet can switch to the chain. Note: a **native gas token** named `eth` is filtered
     out of the **input**-token selector by design (`InputTokenModal`), so for input-side
     demos add at least one ERC-20.
5. Remind the user nothing was committed.

## Reference appendix

**Infra constants** (from `config.ts` L25–57; reused across chains):

```
ADDRESS_ZERO                      0x0000000000000000000000000000000000000000
COIN_FILLER                       0x75220B7600c300005038432a0000f308e0000068
COMPACT                           0x00000000000000171ede64904551eeDF3C6C9788
INPUT_SETTLER_COMPACT_LIFI        0x0000000000cd5f7fDEc90a03a31F79E5Fbc6A9Cf
INPUT_SETTLER_ESCROW_LIFI         0x00fC00edbe7C003b006f870068c548940000223e
MULTICHAIN_INPUT_SETTLER_ESCROW   0xb912b4c38ab54b94D45Ac001484dEBcbb519Bc2B
MULTICHAIN_INPUT_SETTLER_COMPACT  0x1fccC0807F25A58eB531a0B5b4bf3dCE88808Ed7
POLYMER_ORACLE (mainnet bucket)   0x008C3800F3Ad9b3B662d002E90Cc00000000eE17
POLYMER_ORACLE (testnet bucket)   0xC401b53377b8A71A7cEB820e6a4dC53832343a90
```

**Reference chains / RPCs:** mainnet → `base`, `https://base-rpc.publicnode.com`;
testnet → `baseSepolia`, `https://base-sepolia-rpc.publicnode.com`.

**Deps** (already present): `cast` (foundry), `bun`, `viem`, `curl`.
