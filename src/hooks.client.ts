import { Buffer } from "buffer";
// Buffer is not available in browser environments by default.
// Polyfill it globally so Solana/Anchor libraries that depend on Node's Buffer
// can run client-side. This hook runs only in the browser (never SSR), which
// is the correct place for browser-only globals.
globalThis.Buffer = Buffer;
