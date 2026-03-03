import { expect, test, type Page } from "@playwright/test";
import {
	connectInjectedWallet,
	e2eWalletAddress,
	hasE2EPrivateKey,
	installInjectedWalletProvider
} from "./helpers/bootstrap";

const REQUIRED_INPUT_USDC_RAW = "100";
const TEST_TIMEOUT_MS = 2 * 60_000;
const UI_TIMEOUT_MS = 30_000;
const TX_TIMEOUT_MS = 45_000;
const ORDER_STATUS_CLAIMED = 2;
const PROVE_ATTEMPT_TIMEOUT_MS = 20_000;

test.skip(!hasE2EPrivateKey, "Skipping private-key E2E tests: E2E_PRIVATE_KEY is not defined.");

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

test("executes full standard escrow flow from base to arbitrum with raw input 100", async ({
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

	// Keep the flow deterministic by fixing tiny standard-order assets directly in state.
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
			if (!baseUsdc || !arbitrumUsdc) {
				throw new Error("Could not resolve base/arbitrum USDC from coin list.");
			}

			store.mainnet = true;
			store.intentType = "escrow";
			store.orders = [];
			store.inputTokens = [{ token: baseUsdc, amount: BigInt(amount) }];
			store.outputTokens = [{ token: arbitrumUsdc, amount: BigInt(amount) }];
			store.exclusiveFor = issuer;
			store.useExclusiveForQuoteRequest = true;
		},
		{ amount: REQUIRED_INPUT_USDC_RAW, issuer: issuerAddress }
	);

	await page.getByRole("button", { name: "→" }).first().click();
	await expect(page.getByRole("heading", { name: "Intent Issuance" })).toBeVisible();

	await page.getByTestId("quote-button").click();
	await expect.poll(() => sawExpectedQuotePayload).toBe(true);
	await expect.poll(() => sawExclusiveForIssuer).toBe(true);

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
	// Exact raw input is asserted at quote request time; here we assert the selected order still has input.
	expect(observedInputRaw).not.toBeNull();
	expect(BigInt(observedInputRaw as string)).toBeGreaterThan(0n);

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

	const proveButton = page.getByRole("button", { name: /^\d+(\.\d+)?\s+USDC$/ }).first();
	let validated = false;
	for (let attempt = 0; attempt < 4; attempt++) {
		await expect(proveButton).toBeVisible({ timeout: UI_TIMEOUT_MS });
		await expect(proveButton).toBeEnabled({ timeout: UI_TIMEOUT_MS });
		await proveButton.click();
		try {
			await expect
				.poll(
					async () =>
						await page.evaluate(async () => {
							const { default: store } = await import("/src/lib/state.svelte.ts");
							const { getOrderProgressChecks } = await import("/src/lib/libraries/flowProgress.ts");
							const latest = store.orders.at(-1);
							if (!latest) return false;
							const checks = await getOrderProgressChecks(latest, store.fillTransactions);
							return checks.allValidated;
						}),
					{ timeout: PROVE_ATTEMPT_TIMEOUT_MS, intervals: [1_000, 2_000, 4_000] }
				)
				.toBe(true);
			validated = true;
			break;
		} catch {
			await page.waitForTimeout(3_000);
		}
	}
	expect(validated).toBe(true);

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
