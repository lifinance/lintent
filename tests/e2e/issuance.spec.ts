import { expect, test } from "@playwright/test";
import { mockQuoteResponse } from "../fixtures/mockQuote";
import { bootstrapConnectedWallet } from "./helpers/bootstrap";

test.beforeEach(async ({ page }) => {
	await page.route("**/quote/request", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(mockQuoteResponse)
		});
	});
	await page.route("**/orders/status/*", async (route) => {
		const now = Math.floor(Date.now() / 1000);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				data: {
					order: {
						user: "0x1111111111111111111111111111111111111111",
						nonce: "123",
						originChainId: "8453",
						expires: now + 3600,
						fillDeadline: now + 1800,
						inputOracle: "0x0000000000000000000000000000000000000001",
						inputs: [["1", "1000000"]],
						outputs: [
							{
								oracle: "0x0000000000000000000000000000000000000000000000000000000000000001",
								settler: "0x0000000000000000000000000000000000000000000000000000000000000001",
								chainId: "42161",
								token: "0x0000000000000000000000000000000000000000000000000000000000000001",
								amount: "1000000",
								recipient: "0x0000000000000000000000000000000000000000000000000000000000000001",
								callbackData: "0x",
								context: "0x"
							}
						]
					},
					inputSettler: "0x00fC00edbe7C003b006f870068c548940000223e",
					sponsorSignature: null,
					allocatorSignature: null
				}
			})
		});
	});

	await page.goto("/");
	await bootstrapConnectedWallet(page);
});

test("asset management controls remain interactive", async ({ page }) => {
	await expect(page.getByRole("heading", { name: "Assets Management" })).toBeVisible();

	await page.getByTestId("network-mainnet").click();
	await page.getByTestId("network-testnet").click();
	await page.getByTestId("intent-type-compact").click();
	await page.getByTestId("intent-type-escrow").click();
	await page.getByTestId("intent-type-compact").click();

	await expect(page.getByTestId("allocator-116450367070547927622991121")).toBeVisible();
	await page.getByTestId("allocator-116450367070547927622991121").click();
});

test("input/output modals open and save in issuance screen", async ({ page }) => {
	await page.getByRole("button", { name: "→" }).click();
	await expect(page.getByRole("heading", { name: "Intent Issuance" })).toBeVisible();

	await page.getByTestId("open-input-modal-0").click();
	await expect(page.getByTestId("input-token-modal")).toBeVisible();
	await page.getByTestId("input-token-modal-save").click();
	await expect(page.getByTestId("input-token-modal")).toBeHidden();

	await page.getByTestId("open-output-modal-0").click();
	await expect(page.getByTestId("output-token-modal")).toBeVisible();
	await page.getByTestId("output-token-add").click();
	await page.getByTestId("output-token-modal-save").click();
	await expect(page.getByTestId("output-token-modal")).toBeHidden();

	await page.getByTestId("quote-button").click();
	await expect(page.getByTestId("quote-button")).toBeVisible();
});

test("imports order by order id into intent list", async ({ page }) => {
	await page.getByRole("button", { name: "→" }).click();
	await page.getByRole("button", { name: "→" }).click();
	await expect(page.getByRole("heading", { name: "Select Intent To Solve" })).toBeVisible();

	await page
		.getByTestId("intent-import-order-id")
		.fill("0x1111111111111111111111111111111111111111111111111111111111111111");
	await page.getByTestId("intent-import-order-submit").click();

	await expect(page.getByTestId("intent-import-order-id")).toHaveValue("");
});
