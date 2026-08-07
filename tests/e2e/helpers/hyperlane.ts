import { expect, type Page } from "@playwright/test";
import { ARBITRUM_CHAIN_ID, BASE_CHAIN_ID } from "./bootstrap";

/**
 * Hyperlane oracle addresses, hardcoded on purpose.
 *
 * The whole point of these assertions is that the app wires the INPUT chain's oracle
 * into `order.inputOracle` and the OUTPUT chain's oracle into `output.oracle` — the
 * inverse of Polymer, which uses the input chain's oracle for both. Reading the
 * expected values back out of `$lib/config` would make the assertion tautological, so
 * the addresses are pinned here and must be updated deliberately on redeployment.
 */
export const BASE_HYPERLANE_ORACLE = "0x24d39b2807c6B50882fB6B9a4B4Dc6D36bbb297d" as const;
export const ARBITRUM_HYPERLANE_ORACLE = "0x2A2A7570354787A6D5D797b43EE5f5c1f6a0f163" as const;

/**
 * `@lifi/intent` is a bare specifier, which the browser cannot resolve from
 * `page.evaluate`. Two servable URLs point at the same module under Vite dev:
 *
 *  1. the pre-bundled dependency, which the app itself already imports. Preferred,
 *     because loading it cannot make Vite discover new dependencies — and a
 *     dependency discovery mid-test triggers a full page reload, which would wipe the
 *     store state the spec has just set up.
 *  2. the package's real ESM entry, as a fallback if the dep cache is not populated.
 */
const LIFI_INTENT_MODULES = [
  "/node_modules/.vite/deps/@lifi_intent.js",
  "/node_modules/@lifi/intent/_esm/index.js"
];

export type OrderWiring = {
  verifier: string;
  inputChainId: string;
  inputOracle: string;
  outputs: Array<{ chainId: string; oracle: string; settler: string }>;
};

/**
 * Builds the escrow order the app would build for `verifier`, using the app's own
 * `intentDeps`, WITHOUT sending anything. This is what lets a wiring regression fail
 * before a single wei of gas — let alone interchain gas — has been spent.
 */
export async function buildOrderWiring(
  page: Page,
  verifier: "polymer" | "hyperlane",
  opts: { account: string; amountRaw: string }
): Promise<OrderWiring> {
  return await page.evaluate(
    async ({ verifier, account, amountRaw, lifiIntentModules }) => {
      let lifiIntent: typeof import("@lifi/intent") | undefined;
      for (const candidate of lifiIntentModules) {
        try {
          lifiIntent = (await import(
            /* @vite-ignore */ candidate
          )) as typeof import("@lifi/intent");
          break;
        } catch {
          // try the next servable URL
        }
      }
      if (!lifiIntent) throw new Error("Could not import @lifi/intent from the page context");
      const { Intent, bytes32ToAddress } = lifiIntent;
      const { intentDeps } = await import("/src/lib/libraries/coreDeps.ts");
      const { coinList, chainMap } = await import("/src/lib/config.ts");

      const coins = coinList(true);
      const findUsdc = (chainId: number) =>
        coins.find((token) => token.chainId === chainId && token.name === "usdc");
      const baseUsdc = findUsdc(chainMap.base.id);
      const arbitrumUsdc = findUsdc(chainMap.arbitrum.id);
      if (!baseUsdc || !arbitrumUsdc) throw new Error("Could not resolve mainnet USDC tokens");

      const toContext = (token: typeof baseUsdc) => ({
        token: {
          address: token.address,
          name: token.name,
          chainId: BigInt(token.chainId),
          decimals: token.decimals,
          chainNamespace: "eip155" as const
        },
        amount: BigInt(amountRaw)
      });

      const intent = new Intent(
        {
          exclusiveFor: undefined,
          inputTokens: [toContext(baseUsdc)],
          outputTokens: [toContext(arbitrumUsdc)],
          verifier,
          account: account as `0x${string}`,
          outputRecipient: undefined,
          lock: { type: "escrow" }
        },
        intentDeps
      );
      const order = intent.order().asOrder() as {
        originChainId?: bigint;
        inputOracle: `0x${string}`;
        outputs: Array<{ chainId: bigint; oracle: `0x${string}`; settler: `0x${string}` }>;
      };

      return {
        verifier,
        inputChainId: order.originChainId?.toString() ?? "",
        inputOracle: order.inputOracle,
        outputs: order.outputs.map((output) => ({
          chainId: output.chainId.toString(),
          oracle: bytes32ToAddress(output.oracle),
          settler: bytes32ToAddress(output.settler)
        }))
      };
    },
    {
      verifier,
      account: opts.account,
      amountRaw: opts.amountRaw,
      lifiIntentModules: LIFI_INTENT_MODULES
    }
  );
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The highest-value regression guard in the Hyperlane feature: the input and output
 * oracles are DIFFERENT addresses, and each belongs to its own chain. Getting this
 * backwards produces an order that can be opened and filled but never proven, so it
 * is asserted before any transaction is sent.
 */
export function assertHyperlaneWiring(wiring: OrderWiring) {
  expect(wiring.inputChainId).toBe(String(BASE_CHAIN_ID));
  expect(sameAddress(wiring.inputOracle, BASE_HYPERLANE_ORACLE)).toBe(true);
  expect(wiring.outputs).toHaveLength(1);
  expect(wiring.outputs[0].chainId).toBe(String(ARBITRUM_CHAIN_ID));
  expect(sameAddress(wiring.outputs[0].oracle, ARBITRUM_HYPERLANE_ORACLE)).toBe(true);
  // Explicit inversion check: for Hyperlane the two oracles must not be the same
  // address, which is exactly what a copy of the Polymer rule would produce.
  expect(sameAddress(wiring.outputs[0].oracle, wiring.inputOracle)).toBe(false);
}

/** Reads `store.verifier`, the binding the `#verified-by` select must actually drive. */
export async function readStoreVerifier(page: Page) {
  return await page.evaluate(async () => {
    const { default: store } = await import("/src/lib/state.svelte.ts");
    return store.verifier as string;
  });
}

export type HyperlaneSubmissionView = {
  key: string;
  orderId: string;
  inputChainId: number;
  outputChainId: number;
  submitTxHash: string;
  messageId?: string;
  submittedAt: number;
};

/**
 * Reads the persisted per-order Hyperlane submit records.
 *
 * This is the app's own evidence that `submit` ran and interchain gas was paid — it is
 * written before the submit receipt is awaited and survives a reload. Earlier revisions
 * of this helper had to scan `store.transactionReceipts` for a receipt addressed to the
 * output-chain oracle, because nothing else recorded the dispatch; that workaround is no
 * longer needed.
 */
export async function readHyperlaneSubmissions(page: Page): Promise<HyperlaneSubmissionView[]> {
  return await page.evaluate(async () => {
    const { default: store } = await import("/src/lib/state.svelte.ts");
    return Object.values(store.hyperlaneSubmissions).map((submission) => ({ ...submission }));
  });
}

/**
 * Writes a synthetic submit record for every (input chain, output) pair of the latest
 * order, exactly as `Solver.proveHyperlane` would after dispatching. Keyless: it moves
 * the app into the "message in flight" state without sending anything.
 */
export async function injectHyperlaneSubmission(
  page: Page,
  opts: { submitTxHash: `0x${string}`; messageId?: `0x${string}` }
) {
  return await page.evaluate(async ({ submitTxHash, messageId }) => {
    const { default: store } = await import("/src/lib/state.svelte.ts");
    const { containerToIntent } = await import("/src/lib/utils/intent.ts");
    const { getOutputStorageKey } = await import("/src/lib/libraries/flowProgress.ts");
    const { hyperlaneSubmissionKey } = await import("/src/lib/libraries/hyperlaneSubmission.ts");
    const container = store.orders.at(-1);
    if (!container) throw new Error("No order to attach a Hyperlane submission to");
    const intent = containerToIntent(container);
    const orderId = intent.orderId();
    const keys: string[] = [];
    for (const inputChain of intent.inputChains()) {
      for (const output of container.order.outputs) {
        const outputHash = getOutputStorageKey(output);
        const key = hyperlaneSubmissionKey(orderId, inputChain, outputHash);
        await store.saveHyperlaneSubmission({
          key,
          orderId,
          inputChainId: Number(inputChain),
          outputChainId: Number(output.chainId),
          outputHash,
          // Not a real payload hash: this spec never fills, and only the solver's
          // duplicate-payment check compares it.
          payloadHash: outputHash as `0x${string}`,
          submitTxHash,
          messageId,
          submittedAt: Math.floor(Date.now() / 1000)
        });
        keys.push(key);
      }
    }
    return keys;
  }, opts);
}

/**
 * Pushes a locally-built Hyperlane escrow order into `store.orders` so the solver
 * screens have something to select. No transaction is sent, so the order does not
 * exist on chain — only use this in black-box specs.
 */
export async function injectSyntheticHyperlaneOrder(page: Page, opts: { account: string }) {
  return await page.evaluate(
    async ({ account, lifiIntentModules }) => {
      let lifiIntent: typeof import("@lifi/intent") | undefined;
      for (const candidate of lifiIntentModules) {
        try {
          lifiIntent = (await import(
            /* @vite-ignore */ candidate
          )) as typeof import("@lifi/intent");
          break;
        } catch {
          // try the next servable URL
        }
      }
      if (!lifiIntent) throw new Error("Could not import @lifi/intent from the page context");
      const { Intent } = lifiIntent;
      const { intentDeps } = await import("/src/lib/libraries/coreDeps.ts");
      const { coinList, chainMap } = await import("/src/lib/config.ts");
      const { default: store } = await import("/src/lib/state.svelte.ts");

      const coins = coinList(true);
      const findUsdc = (chainId: number) =>
        coins.find((token) => token.chainId === chainId && token.name === "usdc");
      const baseUsdc = findUsdc(chainMap.base.id);
      const arbitrumUsdc = findUsdc(chainMap.arbitrum.id);
      if (!baseUsdc || !arbitrumUsdc) throw new Error("Could not resolve mainnet USDC tokens");

      const toContext = (token: typeof baseUsdc) => ({
        token: {
          address: token.address,
          name: token.name,
          chainId: BigInt(token.chainId),
          decimals: token.decimals,
          chainNamespace: "eip155" as const
        },
        amount: 100n
      });

      const intent = new Intent(
        {
          exclusiveFor: undefined,
          inputTokens: [toContext(baseUsdc)],
          outputTokens: [toContext(arbitrumUsdc)],
          verifier: "hyperlane",
          account: account as `0x${string}`,
          outputRecipient: undefined,
          lock: { type: "escrow" }
        },
        intentDeps
      );
      const built = intent.order() as { asOrder: () => unknown; inputSettler: `0x${string}` };
      const container = {
        order: built.asOrder(),
        inputSettler: built.inputSettler,
        sponsorSignature: { type: "None", payload: "0x" },
        allocatorSignature: { type: "None", payload: "0x" }
      } as unknown as (typeof store.orders)[number];

      store.orders = [container];
      return {
        inputSettler: container.inputSettler,
        outputSettler: container.order.outputs[0].settler
      };
    },
    { account: opts.account, lifiIntentModules: LIFI_INTENT_MODULES }
  );
}
