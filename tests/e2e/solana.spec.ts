import { expect, test, type Page } from "@playwright/test";
import type { StandardSolana } from "@lifi/intent";

async function setup(
  page: Page,
  options: {
    simulationFailure?: boolean;
    restore?: boolean;
    noPreset?: boolean;
    singleReceiptRead?: boolean;
  } = {}
) {
  await page.route("**/quote/request", (route) => route.fulfill({ json: { quotes: [] } }));
  await page.routeWebSocket(/^wss?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (socket) =>
    socket.close()
  );
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof BigInt.prototype.toJSON === "function");
  return page.evaluate(async (options) => {
    const { installScenario } = await import("/tests/e2e/helpers/solanaScenario.ts");
    return installScenario(options);
  }, options);
}

async function select(page: Page, id: string) {
  await page.getByTestId(`intent-select-${id}`).press("Enter");
  await expect(page.getByLabel("Fill method")).toHaveValue("atomic");
}

async function screenshotAfterScroll(page: Page, path: string) {
  // Wait for the carousel's smooth scrolling to stop before capturing it.
  await page.locator(".snap-x").evaluate(async (element) => {
    for (;;) {
      const left = element.scrollLeft;
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (element.scrollLeft === left) return;
    }
  });
  await page.screenshot({ path, fullPage: true });
}

test("Solana issuance builds open with the new interface", async ({ page }) => {
  await setup(page, { noPreset: true });
  await page.getByRole("button", { name: "Execute Open", exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          (await import("/tests/e2e/helpers/solanaScenario.ts")).inspectScenario().submissions
      )
    )
    .toEqual([["open"]]);
});

test("atomic fill completes, rent can be reclaimed, and history survives reload", async ({
  page
}) => {
  const { id } = await setup(page);
  await select(page, id);
  await expect(page.getByText("UNKNOWN", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fill and settle", exact: true })).toBeInViewport();
  await screenshotAfterScroll(page, "test-results/solana-atomic-ready.png");
  await page.getByRole("button", { name: "Fill and settle", exact: true }).click();
  await expect(page.getByText("Intent fully solved.", { exact: true })).toBeVisible();
  const state = await page.evaluate(async () =>
    (await import("/tests/e2e/helpers/solanaScenario.ts")).inspectScenario()
  );
  expect(state.submissions).toEqual([["finalise_with_prefill", "fill_samechain"]]);
  expect(state.signed).toBe(1);
  await page.getByRole("button", { name: /^Claim \(/ }).click();
  await expect(page.getByText("Intent fully solved.", { exact: true })).toBeInViewport();
  await screenshotAfterScroll(page, "test-results/solana-atomic-settled.png");
  await expect(page.getByRole("button", { name: "Reclaim rent", exact: true })).toBeDisabled();
  await page.evaluate(async () =>
    (await import("/tests/e2e/helpers/solanaScenario.ts")).makeRentReclaimable()
  );
  await page.getByRole("button", { name: "Refresh rent status" }).click();
  await page.evaluate(async () =>
    (await import("/tests/e2e/helpers/solanaScenario.ts")).receiptStorageAvailable(false)
  );
  await page.getByRole("button", { name: "Reclaim rent", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Local receipt storage is unavailable");
  expect(
    await page.evaluate(
      async () => (await import("/tests/e2e/helpers/solanaScenario.ts")).inspectScenario().signed
    )
  ).toBe(1);
  await page.evaluate(async () =>
    (await import("/tests/e2e/helpers/solanaScenario.ts")).receiptStorageAvailable(true)
  );
  await page.getByRole("button", { name: "Reclaim rent", exact: true }).click();
  await expect(page.getByText("Fill record rent already reclaimed.")).toBeVisible();
  await page.clock.setFixedTime(new Date(Date.now() + 3 * 86400_000));
  await setup(page, { restore: true });
  await page.getByTestId(`intent-expired-${id}`).press("Enter");
  await page.getByRole("button", { name: "View settlement and rent" }).click();
  await expect(page.getByText("Intent fully solved.", { exact: true })).toBeVisible();
  await expect(page.getByText("Fill record rent already reclaimed.")).toBeVisible();
});

test("ordinary filling keeps a separate claim step", async ({ page }) => {
  const { id } = await setup(page);
  await select(page, id);
  await page.getByLabel("Fill method").selectOption("ordinary");
  await page.getByRole("button", { name: "Fill", exact: true }).click();
  await expect(page.getByText("Intent fully solved.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByText("Intent fully solved.", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      async () =>
        (await import("/tests/e2e/helpers/solanaScenario.ts")).inspectScenario().submissions
    )
  ).toEqual([["fill"], ["finalise"]]);
});

test("stale fill signatures fall back to live accounts and matching saved receipts", async ({
  page
}) => {
  const { orderContainer } = await setup(page);
  const result = await page.evaluate(async (container) => {
    const { default: store } = await import("/src/lib/state.svelte.ts");
    const { getSolanaReads } = await import("/src/lib/solana/client.ts");
    const { isOutputFilled } = await import("/src/lib/libraries/fillStatus.ts");
    const { solanaOrderSettled, rememberSolanaFill } = await import(
      "/src/lib/libraries/solanaHistory.ts"
    );
    const { solanaOrderId } = await import("/src/lib/solana/order.ts");
    const { fillReceipt } = await import("/tests/fixtures/solana/transactions.ts");
    const { fillRecordData } = await import("/tests/fixtures/solana/accounts.ts");
    const { bytes32ToPubkey } = await import("/src/lib/solana/pda.ts");
    const { OUTPUT_SETTLER_SIMPLE_PROGRAM_ID } = await import("/src/lib/idl/index.ts");
    const order = container.order as StandardSolana;
    const id = solanaOrderId(order);
    const output = order.outputs[0];
    const reads = await getSolanaReads(output.chainId);
    const previous = fillReceipt(
      { ...order, nonce: order.nonce + 1n },
      order.user,
      order.fillDeadline - 1
    );
    reads.getTransaction = async (signature) => {
      if (signature === "unrelated") return previous;
      if (signature === "failed") return { ...previous, meta: { err: "failed", logMessages: [] } };
      if (signature === "unavailable") throw new Error("RPC history unavailable");
      return null;
    };
    const hints = ["unrelated", "failed", "unavailable", "missing"];
    const unfilled = await Promise.all(hints.map((hint) => isOutputFilled(id, output, hint)));
    const unsettled = await Promise.all(hints.map((hint) => solanaOrderSettled(container, hint)));
    const getAccountInfo = reads.getAccountInfo;
    reads.getAccountInfo = async () => ({
      owner: OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
      data: fillRecordData(bytes32ToPubkey(order.user).toBase58()),
      lamports: 1_000_000
    });
    const filled = await Promise.all(hints.map((hint) => isOutputFilled(id, output, hint)));
    reads.getAccountInfo = getAccountInfo;
    await store.saveTransactionReceipt(
      output.chainId,
      "matching",
      fillReceipt(order, order.user, order.fillDeadline - 1)
    );
    const recovered = await Promise.all(hints.map((hint) => isOutputFilled(id, output, hint)));
    const settled = await Promise.all(hints.map((hint) => solanaOrderSettled(container, hint)));
    const rejectedImports = await Promise.all(
      hints.map((hint) =>
        rememberSolanaFill(id, output, hint).then(
          () => false,
          () => true
        )
      )
    );
    return { unfilled, unsettled, filled, recovered, settled, rejectedImports };
  }, orderContainer);
  expect(result).toEqual({
    unfilled: [false, false, false, false],
    unsettled: [false, false, false, false],
    filled: [true, true, true, true],
    recovered: [true, true, true, true],
    settled: [true, true, true, true],
    rejectedImports: [true, true, true, true]
  });
});

for (const mode of ["atomic", "ordinary"]) {
  test(`${mode} completion reuses confirmation receipts when storage and further RPC reads fail`, async ({
    page
  }) => {
    const { id, orderContainer } = await setup(page, { singleReceiptRead: true });
    await select(page, id);
    await page.getByLabel("Fill method").selectOption(mode);
    await page.evaluate(async () =>
      (await import("/tests/e2e/helpers/solanaScenario.ts")).receiptStorageAvailable(false)
    );
    await page
      .getByRole("button", { name: mode === "atomic" ? "Fill and settle" : "Fill", exact: true })
      .click();
    if (mode === "ordinary") await page.getByRole("button", { name: "Claim", exact: true }).click();
    await expect(page.getByText("Intent fully solved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const state = await page.evaluate(async (container) => {
      const { default: store } = await import("/src/lib/state.svelte.ts");
      const { getOutputStorageKey } = await import("/src/lib/libraries/flowProgress.ts");
      const { inspectScenario } = await import("/tests/e2e/helpers/solanaScenario.ts");
      await store.loadFillTransactionsFromDb();
      return {
        ...inspectScenario(),
        fillSignature: store.fillTransactions[getOutputStorageKey(container.order.outputs[0])]
      };
    }, orderContainer);
    expect(state.fillSignature).toBeTruthy();
    expect(state.submissions).toEqual(
      mode === "atomic" ? [["finalise_with_prefill", "fill_samechain"]] : [["fill"], ["finalise"]]
    );
    expect(Object.values(state.transactionReads)).toEqual(mode === "atomic" ? [1] : [1, 1]);
  });
}

test("failed simulation never requests a wallet signature or reports completion", async ({
  page
}) => {
  const { id } = await setup(page, { simulationFailure: true });
  await select(page, id);
  await page.getByRole("button", { name: "Fill and settle", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Insufficient output funds" })
  ).toBeVisible();
  const state = await page.evaluate(async () =>
    (await import("/tests/e2e/helpers/solanaScenario.ts")).inspectScenario()
  );
  expect(state.signed).toBe(0);
  expect(state.submissions).toEqual([]);
  await expect(page.getByText("Intent fully solved.", { exact: true })).toHaveCount(0);
});
