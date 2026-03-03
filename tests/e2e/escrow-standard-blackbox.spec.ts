import { expect, test, type Page } from "@playwright/test";
import {
	connectInjectedWallet,
	e2eWalletAddress,
	hasE2EPrivateKey,
	installInjectedWalletProvider
} from "./helpers/bootstrap";

const REQUIRED_INPUT_USDC_HUMAN = "0.0001";
const REQUIRED_INPUT_USDC_RAW = "100";
const TEST_TIMEOUT_MS = 2 * 60_000;
const UI_TIMEOUT_MS = 30_000;
const TX_TIMEOUT_MS = 45_000;
const PROVE_ATTEMPT_TIMEOUT_MS = 20_000;
const ORDER_STATUS_CLAIMED = 2;
type FlowStepName = "Asset" | "Issue" | "Fetch" | "Fill" | "Prove" | "Claim";
type FlowStepStatus = "Now" | "Done" | "Next" | "Locked";
type FlowState = Record<FlowStepName, FlowStepStatus>;

test.skip(!hasE2EPrivateKey, "Skipping private-key E2E tests: E2E_PRIVATE_KEY is not defined.");

test.setTimeout(TEST_TIMEOUT_MS);

async function expectRightRailState(page: Page, state: FlowState) {
	const entries = Object.entries(state) as Array<[FlowStepName, FlowStepStatus]>;
	for (const [step, status] of entries) {
		await expect(page.getByRole("button", { name: `${step} (${status})` })).toBeVisible({
			timeout: UI_TIMEOUT_MS
		});
	}
}

async function lockVerticalScrollAtTop(page: Page) {
	await page.addInitScript(() => {
		const enforceTop = () => {
			if (window.scrollY > 0) window.scrollTo(0, 0);
		};
		window.addEventListener("scroll", enforceTop, { passive: true });
		window.addEventListener("load", enforceTop);
	});
}

test("black-box escrow flow shows expected UI state transitions", async ({ page }) => {
	const issuerAddress = e2eWalletAddress();
	let sawRequiredInputAmount = false;
	const getReceiptCount = async () =>
		await page.evaluate(async () => {
			const { default: store } = await import("/src/lib/state.svelte.ts");
			return Object.keys(store.transactionReceipts).length;
		});

	await lockVerticalScrollAtTop(page);

	await page.route("**/quote/request", async (route) => {
		const body = route.request().postDataJSON() as
			| {
					intent?: {
						inputs?: Array<{ amount?: string }>;
					};
			  }
			| undefined;
		const totalInputRaw = (body?.intent?.inputs ?? []).reduce((sum, input) => {
			try {
				return sum + BigInt(input.amount ?? "0");
			} catch {
				return sum;
			}
		}, 0n);
		if (totalInputRaw.toString() === REQUIRED_INPUT_USDC_RAW) {
			sawRequiredInputAmount = true;
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
	await expectRightRailState(page, {
		Asset: "Now",
		Issue: "Next",
		Fetch: "Next",
		Fill: "Locked",
		Prove: "Locked",
		Claim: "Locked"
	});

	await page.getByTestId("network-mainnet").click();
	await page.getByTestId("intent-type-escrow").click();

	await page.getByRole("button", { name: "→" }).first().click();
	await expect(page.getByRole("heading", { name: "Intent Issuance" })).toBeVisible();
	await expectRightRailState(page, {
		Asset: "Done",
		Issue: "Now",
		Fetch: "Next",
		Fill: "Locked",
		Prove: "Locked",
		Claim: "Locked"
	});

	await page.getByTestId("open-input-modal-0").click();
	const inputModal = page.getByTestId("input-token-modal");
	await expect(inputModal).toBeVisible({ timeout: UI_TIMEOUT_MS });
	await inputModal.locator("select#tokenSelector").selectOption("usdc");

	const baseRow = inputModal.getByTestId("input-token-row-base");
	await baseRow.locator('input[type="checkbox"]').check();
	await baseRow.locator('input[type="number"]').fill(REQUIRED_INPUT_USDC_HUMAN);
	await page.getByTestId("input-token-modal-save").click();
	await expect(inputModal).toBeHidden({ timeout: UI_TIMEOUT_MS });

	const exclusiveInput = page.getByPlaceholder("0x... (optional)");
	await exclusiveInput.fill(issuerAddress);
	await page.getByLabel("Lock Exclusive").check();
	await expect(exclusiveInput).toHaveValue(issuerAddress);

	await page.getByTestId("quote-button").click();
	await expect(page.getByTestId("quote-button")).toBeVisible();
	await expect.poll(() => sawRequiredInputAmount).toBe(true);

	if (
		await page
			.getByRole("button", { name: "Set allowance" })
			.isVisible()
			.catch(() => false)
	) {
		await page.getByRole("button", { name: "Set allowance" }).click();
	}

	const executeOpenButton = page.getByRole("button", { name: "Execute Open" });
	await expect(executeOpenButton).toBeVisible({ timeout: TX_TIMEOUT_MS });
	await executeOpenButton.click();

	await expect(page.getByRole("heading", { name: "Select Intent To Solve" })).toBeVisible({
		timeout: TX_TIMEOUT_MS
	});
	await expectRightRailState(page, {
		Asset: "Done",
		Issue: "Done",
		Fetch: "Now",
		Fill: "Locked",
		Prove: "Locked",
		Claim: "Locked"
	});

	const activeIntentRow = page.getByRole("button", { name: /SingleChain/i }).first();
	await expect(activeIntentRow).toBeVisible({ timeout: UI_TIMEOUT_MS });
	await expect(page.getByRole("button", { name: /IN 0\.0001 USDC on base/i }).first()).toBeVisible({
		timeout: UI_TIMEOUT_MS
	});
	await activeIntentRow.click();
	const currentOrder = await page.evaluate(async () => {
		const { default: store } = await import("/src/lib/state.svelte.ts");
		const { buildBaseIntentRow } = await import("/src/lib/libraries/intentList.ts");
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
			inputChainId
		};
	});
	expect(currentOrder).not.toBeNull();

	await expect(page.getByRole("heading", { name: "Fill Intent" })).toBeVisible({
		timeout: UI_TIMEOUT_MS
	});
	await expectRightRailState(page, {
		Asset: "Done",
		Issue: "Done",
		Fetch: "Done",
		Fill: "Now",
		Prove: "Locked",
		Claim: "Locked"
	});

	const fillButton = page.getByRole("button", { name: /^Fill$/ }).first();
	await expect(fillButton).toBeEnabled({ timeout: UI_TIMEOUT_MS });
	await fillButton.click();

	await expect(page.getByRole("heading", { name: "Submit Proof of Fill" })).toBeVisible({
		timeout: TX_TIMEOUT_MS
	});
	await expectRightRailState(page, {
		Asset: "Done",
		Issue: "Done",
		Fetch: "Done",
		Fill: "Done",
		Prove: "Now",
		Claim: "Locked"
	});

	const proveButton = page.getByRole("button", { name: /^\d+(\.\d+)?\s+USDC$/ }).first();
	let reachedFinalise = false;
	for (let attempt = 0; attempt < 4; attempt++) {
		await expect(proveButton).toBeVisible({ timeout: UI_TIMEOUT_MS });
		await expect(proveButton).toBeEnabled({ timeout: UI_TIMEOUT_MS });
		await proveButton.click();
		try {
			await expect(page.getByRole("heading", { name: "Finalise Intent" })).toBeVisible({
				timeout: PROVE_ATTEMPT_TIMEOUT_MS
			});
			reachedFinalise = true;
			break;
		} catch {
			await page.waitForTimeout(3_000);
		}
	}
	expect(reachedFinalise).toBe(true);

	await expectRightRailState(page, {
		Asset: "Done",
		Issue: "Done",
		Fetch: "Done",
		Fill: "Done",
		Prove: "Done",
		Claim: "Now"
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

	await expectRightRailState(page, {
		Asset: "Done",
		Issue: "Done",
		Fetch: "Done",
		Fill: "Done",
		Prove: "Done",
		Claim: "Now"
	});
});
