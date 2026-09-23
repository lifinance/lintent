import { expect, test, type Page } from "@playwright/test";

async function setup(
  page: Page,
  options: { simulationFailure?: boolean; restore?: boolean; noPreset?: boolean } = {}
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
