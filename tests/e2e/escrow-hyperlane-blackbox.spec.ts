import { expect, test, type Page, type Route } from "@playwright/test";
import { toFunctionSelector, encodeAbiParameters } from "viem";
import {
  READ_ONLY_WALLET_ADDRESS,
  connectInjectedWallet,
  installReadOnlyWalletProvider
} from "./helpers/bootstrap";
import {
  ARBITRUM_HYPERLANE_ORACLE,
  BASE_HYPERLANE_ORACLE,
  assertHyperlaneWiring,
  buildOrderWiring,
  injectHyperlaneSubmission,
  injectSyntheticHyperlaneOrder,
  readHyperlaneSubmissions,
  readStoreVerifier
} from "./helpers/hyperlane";

/**
 * Keyless Hyperlane black-box spec.
 *
 * Covers everything about the Hyperlane path that can be checked without spending:
 * the verifier select is offered and actually bound, the order it produces carries the
 * inverted oracle wiring, the selection is revoked when the route stops supporting it,
 * and the progress tracker distinguishes the two Hyperlane-only pre-states — "filled but
 * nothing dispatched" vs. the "Relaying" wait that only a persisted submit record earns —
 * with that record surviving a reload.
 *
 * There is deliberately no private key here: the injected provider throws on every
 * value-moving RPC method, so this spec cannot send a transaction even by accident.
 */

const REQUIRED_INPUT_USDC_RAW = "100";
const TEST_TIMEOUT_MS = 2 * 60_000;
const UI_TIMEOUT_MS = 30_000;

const NON_ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

const GET_FILL_RECORD_SELECTOR = toFunctionSelector("getFillRecord(bytes32,bytes32)");
const ORDER_STATUS_SELECTOR = toFunctionSelector("orderStatus(bytes32)");

test.setTimeout(TEST_TIMEOUT_MS);

/**
 * Stubs exactly the two `eth_call`s `getOrderProgressChecks` needs to conclude
 * "filled on the output chain, nothing terminal on the input chain": with no fill
 * transaction hash recorded, validation is short-circuited to false locally, which is
 * the state Hyperlane spends its relay window in. Everything else is passed through.
 */
async function stubFilledButUnprovenRpc(page: Page) {
  await page.route(
    (url) => url.protocol.startsWith("http") && !url.hostname.startsWith("127.0.0.1"),
    async (route: Route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.fallback();

      let body: { id?: unknown; method?: string; params?: Array<{ data?: string }> } | undefined;
      try {
        body = request.postDataJSON();
      } catch {
        return route.fallback();
      }
      if (!body || body.method !== "eth_call") return route.fallback();

      const callData = body.params?.[0]?.data ?? "";
      const respond = (result: string) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? 1, result })
        });

      if (callData.startsWith(GET_FILL_RECORD_SELECTOR)) return respond(NON_ZERO_BYTES32);
      if (callData.startsWith(ORDER_STATUS_SELECTOR)) {
        // 0 == Opened: neither claimed nor refunded.
        return respond(encodeAbiParameters([{ type: "uint256" }], [0n]));
      }
      return route.fallback();
    }
  );
}

async function gotoIntentIssuance(page: Page) {
  await expect(page.getByRole("heading", { name: "Assets Management" })).toBeVisible();
  await page.getByTestId("network-mainnet").click();
  await page.getByTestId("intent-type-escrow").click();

  // Fix the route in state rather than through the modals: the +page effect resets
  // tokens asynchronously after the network sync, so poll-and-reinject until it sticks.
  await expect
    .poll(
      async () =>
        await page.evaluate(async (amount) => {
          const { default: store } = await import("/src/lib/state.svelte.ts");
          const { coinList, chainMap } = await import("/src/lib/config");
          const coins = coinList(true);
          const baseUsdc = coins.find(
            (token) => token.chainId === chainMap.base.id && token.name === "usdc"
          );
          const arbitrumUsdc = coins.find(
            (token) => token.chainId === chainMap.arbitrum.id && token.name === "usdc"
          );
          if (!baseUsdc || !arbitrumUsdc) return "missing-tokens";
          const current = store.inputTokens[0];
          if (
            current?.token.chainId === baseUsdc.chainId &&
            current?.amount === BigInt(amount) &&
            store.outputTokens[0]?.token.chainId === arbitrumUsdc.chainId
          ) {
            return "stable";
          }
          store.mainnet = true;
          store.intentType = "escrow";
          store.orders = [];
          store.inputTokens = [{ token: baseUsdc, amount: BigInt(amount) }];
          store.outputTokens = [{ token: arbitrumUsdc, amount: BigInt(amount) }];
          return "injected";
        }, REQUIRED_INPUT_USDC_RAW),
      { timeout: 20_000, intervals: [500] }
    )
    .toBe("stable");

  await page.getByRole("button", { name: "→" }).first().click();
  await expect(page.getByRole("heading", { name: "Intent Issuance" })).toBeVisible();
}

test("black-box hyperlane escrow path selects hyperlane, wires both oracles and renders relaying", async ({
  page
}) => {
  await stubFilledButUnprovenRpc(page);
  await installReadOnlyWalletProvider(page);
  await page.goto("/");
  await connectInjectedWallet(page);
  await gotoIntentIssuance(page);

  const verifierSelect = page.locator("select#verified-by");
  await expect(verifierSelect).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expect(verifierSelect).toHaveValue("polymer");

  // The Hyperlane option must be offered (and enabled) for an escrow Base -> Arbitrum
  // route, and its label must not carry the "unavailable" hint.
  const hyperlaneOption = verifierSelect.locator('option[value="hyperlane"]');
  await expect(hyperlaneOption).toHaveCount(1);
  await expect(hyperlaneOption).not.toHaveAttribute("disabled", /.*/);
  await expect(hyperlaneOption).toHaveText("Hyperlane");

  await verifierSelect.selectOption("hyperlane");
  await expect(verifierSelect).toHaveValue("hyperlane");
  // The select was previously unbound and inert; assert the store actually moved.
  expect(await readStoreVerifier(page)).toBe("hyperlane");

  // --- Oracle wiring, before anything is sent -------------------------------------
  const hyperlaneWiring = await buildOrderWiring(page, "hyperlane", {
    account: READ_ONLY_WALLET_ADDRESS,
    amountRaw: REQUIRED_INPUT_USDC_RAW
  });
  assertHyperlaneWiring(hyperlaneWiring);

  // Contrast with Polymer, whose output.oracle is the INPUT chain's oracle. This is
  // what makes the Hyperlane assertion above meaningful rather than incidental.
  const polymerWiring = await buildOrderWiring(page, "polymer", {
    account: READ_ONLY_WALLET_ADDRESS,
    amountRaw: REQUIRED_INPUT_USDC_RAW
  });
  expect(polymerWiring.outputs[0].oracle.toLowerCase()).toBe(
    polymerWiring.inputOracle.toLowerCase()
  );
  expect(polymerWiring.inputOracle.toLowerCase()).not.toBe(BASE_HYPERLANE_ORACLE.toLowerCase());
  expect(polymerWiring.outputs[0].oracle.toLowerCase()).not.toBe(
    ARBITRUM_HYPERLANE_ORACLE.toLowerCase()
  );

  // --- Selection is revoked when the issuance path stops supporting Hyperlane -----
  // Compact orders go through the intent API, which has no Hyperlane oracle rows, so
  // a stale "hyperlane" selection would silently build an unsettleable order.
  await page.evaluate(async () => {
    const { default: store } = await import("/src/lib/state.svelte.ts");
    store.intentType = "compact";
  });
  await expect(hyperlaneOption).toHaveAttribute("disabled", /.*/);
  await expect
    .poll(async () => await readStoreVerifier(page), { timeout: UI_TIMEOUT_MS })
    .toBe("polymer");

  await page.evaluate(async () => {
    const { default: store } = await import("/src/lib/state.svelte.ts");
    store.intentType = "escrow";
  });
  await expect(hyperlaneOption).not.toHaveAttribute("disabled", /.*/);
  await verifierSelect.selectOption("hyperlane");
  expect(await readStoreVerifier(page)).toBe("hyperlane");

  // --- The Hyperlane-only "Relaying" progress state -------------------------------
  const settlers = await injectSyntheticHyperlaneOrder(page, {
    account: READ_ONLY_WALLET_ADDRESS
  });
  expect(settlers.inputSettler).toBeTruthy();

  await page.getByRole("button", { name: /^Fetch \(/ }).click();
  await expect(page.getByRole("heading", { name: "Select Intent To Solve" })).toBeVisible({
    timeout: UI_TIMEOUT_MS
  });

  const activeIntentRow = page.getByRole("button", { name: /SingleChain/i }).first();
  await expect(activeIntentRow).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await activeIntentRow.click();

  const readChecks = async () =>
    await page.evaluate(async () => {
      const { default: store } = await import("/src/lib/state.svelte.ts");
      const { getOrderProgressChecks } = await import("/src/lib/libraries/flowProgress.ts");
      const latest = store.orders.at(-1);
      if (!latest) return null;
      return await getOrderProgressChecks(latest, store.fillTransactions);
    });

  // Filled, but nothing dispatched: for Hyperlane the prove step is a SUBMIT the solver
  // has to pay for, and claiming "Relaying" here would announce a message that does not
  // exist. `Prove` is equally wrong — there is no proof to fetch on this rail.
  await expect(page.getByRole("button", { name: /^Submit \(/ })).toBeVisible({
    timeout: UI_TIMEOUT_MS
  });
  await expect(page.getByRole("button", { name: /^Prove \(/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Relaying \(/ })).toHaveCount(0);

  await expect
    .poll(async () => await readChecks(), { timeout: UI_TIMEOUT_MS })
    .toMatchObject({
      allFilled: true,
      allValidated: false,
      allFinalised: false,
      allClaimed: false,
      anyRefunded: false,
      hyperlaneStage: "awaitingSubmit",
      awaitingSubmit: true,
      awaitingRelayer: false
    });

  // --- Once a submit is on record, and only then, the state is "Relaying" -----------
  const SUBMIT_TX_HASH = `0x${"ab".repeat(32)}` as const;
  const MESSAGE_ID = `0x${"cd".repeat(32)}` as const;
  const submissionKeys = await injectHyperlaneSubmission(page, {
    submitTxHash: SUBMIT_TX_HASH,
    messageId: MESSAGE_ID
  });
  expect(submissionKeys.length).toBeGreaterThan(0);

  await expect(page.getByRole("button", { name: /^Relaying \(/ })).toBeVisible({
    timeout: UI_TIMEOUT_MS
  });
  await expect
    .poll(async () => await readChecks(), { timeout: UI_TIMEOUT_MS })
    .toMatchObject({
      allFilled: true,
      allValidated: false,
      hyperlaneStage: "awaitingRelayer",
      awaitingSubmit: false,
      awaitingRelayer: true
    });

  // The record the UI and the duplicate-payment guard both read, and the message id the
  // explorer link is built from, must be persisted — not process-local.
  const submissions = await readHyperlaneSubmissions(page);
  expect(submissions).toHaveLength(submissionKeys.length);
  expect(submissions[0].submitTxHash).toBe(SUBMIT_TX_HASH);
  expect(submissions[0].messageId).toBe(MESSAGE_ID);

  // Surviving a reload is the whole point: a reload used to reset the in-memory
  // duplicate-payment guard, so the next prove click paid interchain gas twice.
  await page.reload();
  await expect
    .poll(async () => (await readHyperlaneSubmissions(page)).map((s) => s.messageId), {
      timeout: UI_TIMEOUT_MS
    })
    .toContain(MESSAGE_ID);
});
