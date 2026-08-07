import { expect, test, type Page } from "@playwright/test";
import process from "node:process";
import {
  ARBITRUM_CHAIN_ID,
  BASE_CHAIN_ID,
  connectInjectedWallet,
  e2eWalletAddress,
  hasE2EPrivateKey,
  hasNativeBalance,
  hasUsdcBalance,
  installInjectedWalletProvider
} from "./helpers/bootstrap";
import {
  ARBITRUM_HYPERLANE_ORACLE,
  BASE_HYPERLANE_ORACLE,
  assertHyperlaneWiring,
  buildOrderWiring,
  readHyperlaneSubmissions,
  readStoreVerifier
} from "./helpers/hyperlane";

/**
 * LIVE mainnet Hyperlane escrow flow, Base -> Arbitrum. Sends real transactions and
 * pays real Hyperlane interchain gas. See the header of `escrow-standard-live.spec.ts`
 * for the shared conventions; the Hyperlane-specific differences are:
 *
 *  - the verifier select is switched to Hyperlane instead of the Polymer default;
 *  - the oracle wiring is asserted BEFORE the open, because a wiring regression would
 *    otherwise only surface after the fill and the interchain-gas payment;
 *  - proving is push-based: the solver's `submit` on the OUTPUT chain dispatches a
 *    Hyperlane message and an independent relayer delivers `handle` on the INPUT
 *    chain. The wait is therefore for a third party, not for a proof endpoint.
 */

const REQUIRED_INPUT_USDC_RAW = "100";
const UI_TIMEOUT_MS = 30_000;
const TX_TIMEOUT_MS = 45_000;
const ORDER_STATUS_CLAIMED = 2;

/**
 * How long to wait for a Hyperlane relayer to deliver `handle` on the input chain.
 *
 * THIS IS A GUESS PENDING MEASUREMENT. Hyperlane publishes no delivery SLA, and the
 * Base <-> Arbitrum latency of this route has not been measured yet. 10 minutes is
 * chosen as "several times any plausible happy path" rather than from data; once we
 * have real numbers, tighten it. `Solver.proveHyperlane` itself gives up after ~150s
 * of internal polling, so the UI step is clicked repeatedly until this budget runs
 * out — a retry after a successful dispatch only polls and never pays again.
 *
 * Override without editing code: E2E_HYPERLANE_RELAY_TIMEOUT_MS=1800000
 */
const HYPERLANE_RELAY_TIMEOUT_MS = Number(
  process.env.E2E_HYPERLANE_RELAY_TIMEOUT_MS?.trim() || 10 * 60_000
);

/** One internal `proveHyperlane` cycle (~150s of polling) plus wallet/UI overhead. */
const PROVE_ATTEMPT_TIMEOUT_MS = 4 * 60_000;

// Room for: open + fill + submit + the relay budget + finalise.
const TEST_TIMEOUT_MS = HYPERLANE_RELAY_TIMEOUT_MS + 6 * 60_000;

/**
 * Minimum native balance on Arbitrum (the OUTPUT chain, where `submit` pays interchain
 * gas). The observed Base <-> Arbitrum quote was ~5.16e13 wei plus the 20% buffer, so
 * 0.0005 ETH is ample headroom for the quote, the fill's own gas and L1 data costs
 * while still catching a genuinely empty wallet before any transaction is sent.
 */
const MIN_ARBITRUM_WEI = 500_000_000_000_000n; // 0.0005 ETH
const MIN_BASE_WEI = 300_000_000_000_000n; // 0.0003 ETH

/**
 * Second, explicit opt-in. A private key alone is not consent: `bun run test:e2e` (and
 * therefore `npm test`) runs every spec in this directory, and this one pays real
 * Hyperlane interchain gas on top of moving USDC. CI retries would multiply that.
 * Run it with:  E2E_RUN_LIVE_HYPERLANE=1 bunx playwright test tests/e2e/escrow-hyperlane-live.spec.ts
 */
const liveRunOptIn = process.env.E2E_RUN_LIVE_HYPERLANE?.trim() === "1";

test.skip(!hasE2EPrivateKey, "Skipping private-key E2E tests: E2E_PRIVATE_KEY is not defined.");
test.skip(
  !liveRunOptIn,
  "Skipping live Hyperlane flow: set E2E_RUN_LIVE_HYPERLANE=1 to authorise real transactions and interchain gas."
);

test.setTimeout(TEST_TIMEOUT_MS);

async function resolveIssuanceActionState(page: Page): Promise<"execute-open" | "low-balance"> {
  const executeOpenButton = page.getByRole("button", { name: "Execute Open" });
  const lowBalanceButton = page.getByRole("button", { name: "Low Balance" });
  const started = Date.now();

  while (Date.now() - started < TX_TIMEOUT_MS) {
    if (await lowBalanceButton.isVisible().catch(() => false)) return "low-balance";
    if (await executeOpenButton.isVisible().catch(() => false)) return "execute-open";
    await page.waitForTimeout(200);
  }

  throw new Error("Timed out waiting for issuance action state (Execute Open or Low Balance).");
}

test("executes full hyperlane escrow flow from base to arbitrum with raw input 100", async ({
  page
}) => {
  const issuerAddress = e2eWalletAddress();
  let sawExpectedQuotePayload = false;
  let sawExclusiveForIssuer = false;
  const getReceiptCount = async () =>
    await page.evaluate(async () => {
      const { default: store } = await import("/src/lib/state.svelte.ts");
      return Object.keys(store.transactionReceipts).length;
    });

  // Balance pre-checks. The Hyperlane path needs native balance on BOTH chains: the
  // open on Base, and the fill plus the interchain-gas payment on Arbitrum.
  const inputRaw = BigInt(REQUIRED_INPUT_USDC_RAW);
  if (!(await hasUsdcBalance(BASE_CHAIN_ID, inputRaw))) {
    test.skip(true, "Skipping live Hyperlane flow: wallet has insufficient Base USDC.");
  }
  if (!(await hasUsdcBalance(ARBITRUM_CHAIN_ID, inputRaw))) {
    test.skip(true, "Skipping live Hyperlane flow: wallet has insufficient Arbitrum USDC to fill.");
  }
  if (!(await hasNativeBalance(BASE_CHAIN_ID, MIN_BASE_WEI))) {
    test.skip(true, "Skipping live Hyperlane flow: wallet has insufficient Base ETH for gas.");
  }
  if (!(await hasNativeBalance(ARBITRUM_CHAIN_ID, MIN_ARBITRUM_WEI))) {
    test.skip(
      true,
      "Skipping live Hyperlane flow: wallet has insufficient Arbitrum ETH for gas + Hyperlane interchain gas."
    );
  }

  await page.route("**/quote/request", async (route) => {
    const body = route.request().postDataJSON() as
      | {
          intent?: {
            metadata?: { exclusiveFor?: string[] | string };
            inputs?: Array<{ amount?: string }>;
            outputs?: Array<{ amount?: string }>;
          };
        }
      | undefined;

    const firstInputAmount = body?.intent?.inputs?.[0]?.amount;
    const firstOutputAmount = body?.intent?.outputs?.[0]?.amount;
    if (firstInputAmount === REQUIRED_INPUT_USDC_RAW && firstOutputAmount === "0") {
      sawExpectedQuotePayload = true;
    }
    const exclusiveForRaw = body?.intent?.metadata?.exclusiveFor;
    const exclusiveFor =
      Array.isArray(exclusiveForRaw) && exclusiveForRaw.length > 0
        ? exclusiveForRaw[0]
        : (exclusiveForRaw ?? "");
    if (exclusiveFor.toLowerCase() === issuerAddress.toLowerCase()) {
      sawExclusiveForIssuer = true;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        quotes: [
          {
            order: null,
            eta: null,
            validUntil: Date.now() + 60_000,
            quoteId: null,
            metadata: { exclusiveFor: issuerAddress },
            preview: {
              inputs: [],
              outputs: [
                {
                  receiver: "0x0000000000000000000000000000000000000000",
                  asset: "0x0000000000000000000000000000000000000000",
                  amount: REQUIRED_INPUT_USDC_RAW
                }
              ]
            },
            provider: null,
            partialFill: false,
            failureHandling: "refund-automatic"
          }
        ]
      })
    });
  });

  await installInjectedWalletProvider(page);
  await page.goto("/");
  await connectInjectedWallet(page);

  await expect(page.getByRole("heading", { name: "Assets Management" })).toBeVisible();
  await page.getByTestId("network-mainnet").click();
  await page.getByTestId("intent-type-escrow").click();

  // Keep the flow deterministic by fixing tiny standard-order assets directly
  // in state. The +page effect resets tokens asynchronously after the network
  // sync, so poll-and-reinject until the injected state survives a check.
  await expect
    .poll(
      async () =>
        await page.evaluate(
          async ({ amount, issuer }) => {
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
            store.exclusiveFor = issuer;
            store.useExclusiveForQuoteRequest = true;
            return "injected";
          },
          { amount: REQUIRED_INPUT_USDC_RAW, issuer: issuerAddress }
        ),
      { timeout: 20_000, intervals: [500] }
    )
    .toBe("stable");

  await page.getByRole("button", { name: "→" }).first().click();
  await expect(page.getByRole("heading", { name: "Intent Issuance" })).toBeVisible();

  // --- Select Hyperlane instead of the Polymer default ----------------------------
  const verifierSelect = page.locator("select#verified-by");
  await expect(verifierSelect).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expect(verifierSelect).toHaveValue("polymer");
  await verifierSelect.selectOption("hyperlane");
  await expect(verifierSelect).toHaveValue("hyperlane");
  // The select is bound to `store.verifier`; if that binding regresses the order would
  // silently be opened as a Polymer order, so assert the store, not just the DOM.
  expect(await readStoreVerifier(page)).toBe("hyperlane");

  // --- Oracle wiring, asserted BEFORE spending anything ---------------------------
  // inputOracle must be the Base oracle and output.oracle the Arbitrum oracle: two
  // different addresses, the inverse of Polymer. A regression here fails for free.
  const wiring = await buildOrderWiring(page, "hyperlane", {
    account: issuerAddress,
    amountRaw: REQUIRED_INPUT_USDC_RAW
  });
  assertHyperlaneWiring(wiring);

  // --- Interchain-gas preflight, still before spending anything -------------------
  // `quoteGasPayment` on the OUTPUT chain's oracle is a pure `eth_call`, and it only
  // succeeds if the oracle is deployed, its hook is configured and the destination
  // domain is enrolled. Doing it here turns "misconfigured route" from a loss after
  // open+fill into a free failure, and prints what the run will actually cost.
  const interchainGasQuote = await page.evaluate(
    async ({ inputChainId, inputOracle, outputChainId, outputOracle, source, account }) => {
      const { getClient } = await import("/src/lib/config.ts");
      const { HYPERLANE_ORACLE_ABI } = await import("/src/lib/abi/hyperlaneoracle.ts");
      try {
        const quote = await getClient(outputChainId).readContract({
          address: outputOracle as `0x${string}`,
          abi: HYPERLANE_ORACLE_ABI,
          functionName: "quoteGasPayment",
          args: [
            inputChainId,
            inputOracle as `0x${string}`,
            // Mirrors `hyperlaneHandleGasLimit(1)` in solver.ts.
            120_000n,
            "0x",
            source as `0x${string}`,
            [`0x${"11".repeat(64)}`]
          ],
          account: account as `0x${string}`
        });
        return { quote: quote.toString(), error: "" };
      } catch (error) {
        return { quote: "", error: (error as Error).message };
      }
    },
    {
      inputChainId: BASE_CHAIN_ID,
      inputOracle: BASE_HYPERLANE_ORACLE,
      outputChainId: ARBITRUM_CHAIN_ID,
      outputOracle: ARBITRUM_HYPERLANE_ORACLE,
      source: wiring.outputs[0].settler,
      account: issuerAddress
    }
  );
  expect(
    interchainGasQuote.error,
    "quoteGasPayment reverted on the Arbitrum oracle: the Hyperlane route is misconfigured, " +
      "so nothing was spent. Check the oracle deployment, its hook and the Base domain enrollment."
  ).toBe("");
  const quotedWei = BigInt(interchainGasQuote.quote);
  expect(quotedWei).toBeGreaterThan(0n);
  // Sanity ceiling: the observed Base <-> Arbitrum quote is ~5.2e13 wei. A quote orders
  // of magnitude above that means a misconfigured hook, not a busy chain — refuse to pay.
  expect(
    quotedWei,
    `Hyperlane interchain gas quote ${quotedWei} wei is far above the ~5.2e13 wei observed for ` +
      "this route; refusing to submit. Investigate the oracle's hook configuration."
  ).toBeLessThan(1_000_000_000_000_000n); // 0.001 ETH
  console.log(
    `Hyperlane interchain gas quote for this run: ${quotedWei} wei (+20% buffer applied by the app).`
  );

  await page.getByTestId("quote-button").click();
  await expect.poll(() => sawExpectedQuotePayload).toBe(true);
  await expect.poll(() => sawExclusiveForIssuer).toBe(true);

  // Selecting the verifier must survive the quote round-trip.
  expect(await readStoreVerifier(page)).toBe("hyperlane");

  if (
    await page
      .getByRole("button", { name: "Set allowance" })
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByRole("button", { name: "Set allowance" }).click();
  }

  const actionState = await resolveIssuanceActionState(page);
  if (actionState === "low-balance") {
    test.skip(true, "Skipping live flow: wallet has insufficient Base USDC for Execute Open.");
  }

  await page.getByRole("button", { name: "Execute Open" }).click();
  await expect(page.getByRole("heading", { name: "Select Intent To Solve" })).toBeVisible({
    timeout: TX_TIMEOUT_MS
  });

  const activeIntentRow = page.getByRole("button", { name: /SingleChain/i }).first();
  await expect(activeIntentRow).toBeVisible({ timeout: TX_TIMEOUT_MS });
  await activeIntentRow.click();

  const currentOrder = await page.evaluate(async () => {
    const { default: store } = await import("/src/lib/state.svelte.ts");
    const { buildBaseIntentRow } = await import("/src/lib/libraries/intentList.ts");
    // Right-most 20 bytes of the bytes32 oracle, without pulling in a bare-specifier
    // import that the browser cannot resolve from `page.evaluate`.
    const bytes32ToAddress = (value: string) => `0x${value.slice(-40)}`;
    const latest = store.orders.at(-1);
    if (!latest) return null;
    const baseRow = buildBaseIntentRow(latest);

    const order = latest.order as
      | { originChainId?: bigint }
      | { inputs?: Array<{ chainId: bigint }> };
    const inputChainId =
      "originChainId" in order && typeof order.originChainId === "bigint"
        ? order.originChainId.toString()
        : (order.inputs?.[0]?.chainId?.toString() ?? "");

    return {
      orderId: baseRow.orderId,
      inputSettler: latest.inputSettler,
      inputChainId,
      inputOracle: latest.order.inputOracle,
      outputOracles: latest.order.outputs.map((output) => bytes32ToAddress(output.oracle)),
      outputChainIds: latest.order.outputs.map((output) => output.chainId.toString())
    };
  });
  expect(currentOrder).not.toBeNull();

  // The order that was actually opened on chain must carry the same inverted wiring
  // the pre-flight check asserted.
  expect(currentOrder?.inputChainId).toBe(String(BASE_CHAIN_ID));
  expect(currentOrder?.inputOracle.toLowerCase()).toBe(BASE_HYPERLANE_ORACLE.toLowerCase());
  expect(currentOrder?.outputChainIds).toEqual([String(ARBITRUM_CHAIN_ID)]);
  expect(currentOrder?.outputOracles.map((oracle) => oracle.toLowerCase())).toEqual([
    ARBITRUM_HYPERLANE_ORACLE.toLowerCase()
  ]);

  const observedInputRaw = await page.evaluate(async () => {
    const { default: store } = await import("/src/lib/state.svelte.ts");
    const latest = store.orders.at(-1) as
      | { order?: { inputs?: Array<[bigint, bigint]> } }
      | undefined;
    const inputs = latest?.order?.inputs;
    if (!inputs || inputs.length === 0) return null;
    const sum = inputs.reduce((acc, input) => acc + input[1], 0n);
    return sum.toString();
  });
  expect(observedInputRaw).toBe(REQUIRED_INPUT_USDC_RAW);

  await expect(page.getByRole("heading", { name: "Fill Intent" })).toBeVisible({
    timeout: UI_TIMEOUT_MS
  });
  await expect(page.getByText(/^arbitrum$/i).last()).toBeVisible();

  const fillButton = page.getByRole("button", { name: /^Fill$/ }).first();
  await expect(fillButton).toBeEnabled({ timeout: UI_TIMEOUT_MS });
  const receiptsBeforeFill = await getReceiptCount();
  await fillButton.click();

  await expect
    .poll(async () => await getReceiptCount(), { timeout: TX_TIMEOUT_MS })
    .toBeGreaterThan(receiptsBeforeFill);

  await expect(page.getByRole("heading", { name: "Submit Proof of Fill" })).toBeVisible({
    timeout: TX_TIMEOUT_MS
  });

  // Once the fill is on chain and nothing has been dispatched, the tracker must show the
  // Hyperlane-specific "Submit" step — not "Prove" (there is no proof to fetch) and not
  // "Relaying" (no message exists yet). The fill-record read is cached for 30s, so allow
  // a few refresh cycles before failing.
  await expect(page.getByRole("button", { name: /^Submit \(/ })).toBeVisible({
    timeout: 90_000
  });

  // --- Submit + relayer wait -------------------------------------------------------
  // Clicking this button calls `submit` on the ARBITRUM oracle and pays interchain
  // gas. Re-clicking is safe: the dispatch is recorded in `store.hyperlaneSubmissions`,
  // which is persisted, so a retry (even after a reload) only polls `isProven` instead of
  // paying again.
  const proveButton = page.getByRole("button", { name: /^\d+(\.\d+)?\s+USDC$/ }).first();
  const readProgress = async () =>
    await page.evaluate(async () => {
      const { default: store } = await import("/src/lib/state.svelte.ts");
      const { getOrderProgressChecks } = await import("/src/lib/libraries/flowProgress.ts");
      const latest = store.orders.at(-1);
      if (!latest) return null;
      return await getOrderProgressChecks(latest, store.fillTransactions);
    });

  const relayDeadline = Date.now() + HYPERLANE_RELAY_TIMEOUT_MS;
  let validated = false;
  let lastError = "";
  while (Date.now() < relayDeadline) {
    await expect(proveButton).toBeVisible({ timeout: UI_TIMEOUT_MS });
    await expect(proveButton).toBeEnabled({ timeout: UI_TIMEOUT_MS });
    await proveButton.click();
    try {
      await expect
        .poll(async () => (await readProgress())?.allValidated ?? false, {
          timeout: Math.min(PROVE_ATTEMPT_TIMEOUT_MS, Math.max(relayDeadline - Date.now(), 1_000)),
          intervals: [5_000]
        })
        .toBe(true);
      validated = true;
      break;
    } catch (error) {
      lastError = (error as Error).message;
      const progress = await readProgress();
      if (progress?.anyRefunded) {
        throw new Error(
          "Order was REFUNDED before the Hyperlane attestation landed: the solver filled and lost " +
            "the output. The relay window is longer than the order's expiry for this route."
        );
      }
      await page.waitForTimeout(5_000);
    }
  }

  if (!validated) {
    // Distinguish "the relayer has not delivered yet" from "proving is broken" using the
    // app's own submit record — written only after `submit` was actually dispatched, and
    // deleted again if the transaction reverted.
    const submissions = await readHyperlaneSubmissions(page);
    const dispatched = submissions.length > 0;
    const diagnosis = dispatched
      ? "RELAYER HAS NOT DELIVERED YET: the app recorded a dispatched Hyperlane submit " +
        `(${submissions
          .map(
            (submission) =>
              `tx ${submission.submitTxHash}` +
              (submission.messageId
                ? ` message ${submission.messageId} — https://explorer.hyperlane.xyz/message/${submission.messageId}`
                : " (no message id parsed)")
          )
          .join("; ")}), so the fill and the ` +
        "interchain-gas payment both went through and the only missing step is a Hyperlane " +
        "relayer calling `handle` on Base. Nothing is lost — the tracker will turn green on its " +
        "own, and re-running the prove step only polls. Widen E2E_HYPERLANE_RELAY_TIMEOUT_MS."
      : "PROVING LOOKS BROKEN: no Hyperlane submit was recorded, so the dispatch itself never " +
        "completed (quote, simulation, chain switch or the write failed) or it reverted. This is " +
        "an app-side failure, not relayer latency — read the console error from the prove button.";
    throw new Error(
      `${diagnosis}\nRelay budget: ${HYPERLANE_RELAY_TIMEOUT_MS}ms.\nLast poll error: ${lastError}`
    );
  }

  await expect(page.getByRole("heading", { name: "Finalise Intent" })).toBeVisible({
    timeout: TX_TIMEOUT_MS
  });

  const claimButton = page.getByRole("button", { name: "Claim" }).first();
  await expect(claimButton).toBeEnabled({ timeout: UI_TIMEOUT_MS });
  const receiptsBeforeClaim = await getReceiptCount();
  await claimButton.click();

  await expect
    .poll(async () => await getReceiptCount(), { timeout: TX_TIMEOUT_MS })
    .toBeGreaterThan(receiptsBeforeClaim);

  await expect
    .poll(
      async () =>
        await page.evaluate(async (orderMeta) => {
          const { getClient } = await import("/src/lib/config.ts");
          const { SETTLER_ESCROW_ABI } = await import("/src/lib/abi/escrow.ts");
          if (!orderMeta) return -1;
          const status = await getClient(orderMeta.inputChainId).readContract({
            address: orderMeta.inputSettler as `0x${string}`,
            abi: SETTLER_ESCROW_ABI,
            functionName: "orderStatus",
            args: [orderMeta.orderId as `0x${string}`]
          });
          return Number(status);
        }, currentOrder),
      { timeout: TX_TIMEOUT_MS }
    )
    .toBe(ORDER_STATUS_CLAIMED);
});
