import { Buffer } from "buffer";

// @solana/web3.js, Anchor's borsh coder and the wallet adapters all assume a
// global `Buffer`. Browsers have none, and the failure is a bare
// "Buffer is not defined" from deep inside a dependency at signing time, so
// install it before any of them load.
//
// Client-only on purpose: the Cloudflare Worker runs with `nodejs_compat`
// (wrangler.toml) and already has Buffer, and `+page.ts` sets `ssr = false`,
// so no server hook is needed.
globalThis.Buffer ??= Buffer;
