import { expect, test, type Page } from "@playwright/test";
import { Intent, addressToBytes32 } from "@lifi/intent";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  concatHex,
  toHex,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { COIN_FILLER_ABI } from "../../src/lib/abi/outputsettler";

const user = "0x1111111111111111111111111111111111111111";
const adapter = "0x6a5003E8c50bA0e188715532602c0f076827b2f0";
const filler = "0x75220B7600c300005038432a0000f308e0000068";
const token = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const tx = `0x${"11".repeat(32)}` as Hex;
const blockHash = `0x${"22".repeat(32)}` as Hex;

async function prepareForm(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(
    async ({ user }) => {
      const { default: store } = await import("/src/lib/state.svelte.ts");
      const { clients, coinList } = await import("/src/lib/config.ts");
      const { wagmiConfig } = await import("/src/lib/utils/wagmi.ts");
      await store.dbReady;
      // Let startup reconnection finish before installing the mock wallet.
      // Otherwise its completion can replace the mock with a disconnected wallet.
      if (wagmiConfig.state.status === "reconnecting") {
        await new Promise<void>((resolve) => {
          const unsubscribe = wagmiConfig.subscribe(
            (state) => state.status,
            (status) => {
              if (status !== "reconnecting") {
                unsubscribe();
                resolve();
              }
            }
          );
        });
      }
      for (const client of Object.values(clients)) {
        client.readContract = async () => 100000000n;
        client.getBalance = async () => 100000000n;
      }
      store.walletConnection = {
        status: "connected",
        address: user,
        addresses: [user],
        chainId: 8453
      };
      store.walletClient = { getChainId: async () => 8453 };
      store.accountForChain = () => user;
      store.mainnet = true;
      await store.syncTokensForNetwork(true);
      const coins = coinList(true);
      store.inputTokens = [
        { token: coins.find((c) => c.chainId === 8453 && c.name === "usdc"), amount: 100n }
      ];
      store.outputTokens = [
        { token: coins.find((c) => c.chainId === 42161 && c.name === "usdc"), amount: 0n }
      ];
    },
    { user }
  );
  await page.locator("#verified-by").waitFor();
  await page.locator("#verified-by").scrollIntoViewIfNeeded();
}

function quote(amount = "90") {
  return {
    quotes: [{ metadata: { exclusiveFor: user }, preview: { inputs: [], outputs: [{ amount }] } }]
  };
}

test("Vow selection sends both oracle contracts and invalidates superseded quotes", async ({
  page
}) => {
  let releaseOld: (() => void) | undefined;
  let oldStarted = false;
  const requests: { intent: { metadata?: { oracle?: { chain: string; address: string }[] } } }[] =
    [];
  await page.route("**/quote/request", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (!body.intent.metadata?.oracle) {
      oldStarted = true;
      await new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      await route.fulfill({ json: quote("999") });
    } else {
      await route.fulfill({ json: quote("90") });
    }
  });
  await prepareForm(page);
  await expect.poll(() => oldStarted).toBe(true);
  await page.locator("#verified-by").selectOption("vow");
  releaseOld?.();
  await expect
    .poll(() => requests.some((request) => !!request.intent?.metadata?.oracle))
    .toBe(true);
  await expect(page.getByTestId("quote-button")).toHaveText("Quote");
  const body = requests.find((request) => request.intent?.metadata?.oracle);
  expect(body?.intent.metadata.oracle).toEqual([
    { chain: "eip155:8453", address: adapter },
    { chain: "eip155:42161", address: adapter }
  ]);
  expect(
    await page.evaluate(async () => {
      const { default: store } = await import("/src/lib/state.svelte.ts");
      return store.outputTokens[0].amount.toString();
    })
  ).toBe("90");
  await page.screenshot({ path: "test-results/vow-quote.png", fullPage: true });

  await page.route("**/quote/request", (route) => route.fulfill({ json: { quotes: [] } }));
  await page.locator("#verified-by").selectOption("polymer");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { default: store } = await import("/src/lib/state.svelte.ts");
        return store.outputTokens[0].amount.toString();
      })
    )
    .toBe("0");
  await page.locator("#verified-by").selectOption("vow");
  await page.getByTestId("quote-button").click();
  await expect(page.getByTestId("quote-button")).toHaveText("No Quote");
  await expect(page.getByRole("button", { name: "Execute Open" })).toBeEnabled();
});

test("Vow blocks non-EVM routes", async ({ page }) => {
  await page.route("**/quote/request", (route) => route.fulfill({ json: quote() }));
  await prepareForm(page);
  await page.locator("#verified-by").selectOption("vow");
  await page.evaluate(async () => {
    const { default: store } = await import("/src/lib/state.svelte.ts");
    store.outputTokens = [
      { ...store.outputTokens[0], token: { ...store.outputTokens[0].token, chainId: 728126428 } }
    ];
  });
  await expect(
    page.getByText(
      "Vow supports EVM chains only. Choose EVM inputs and outputs or another verifier."
    )
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Execute Open" })).toHaveCount(0);
});

test("new mainnets retain valid tokens in the output selector", async ({ page }) => {
  await page.route("**/quote/request", (route) => route.fulfill({ json: { quotes: [] } }));
  await prepareForm(page);
  await page.locator("#verified-by").selectOption("vow");
  await page.getByTestId("open-output-modal-0").click();
  const modal = page.getByTestId("output-token-modal");
  await modal.locator("select").first().selectOption("4663");
  await expect(modal.locator("select").last()).toHaveValue("usdg");
  await page.getByTestId("output-token-modal-save").click();
  await expect(page.getByTestId("open-output-modal-0")).toContainText("USDG");
  await page.getByTestId("open-output-modal-0").click();
  await modal.locator("select").first().selectOption("5042");
  await expect(modal.locator("select").last()).toHaveValue("usdc");
  await page.getByTestId("output-token-modal-save").click();
  await expect(page.getByTestId("open-output-modal-0")).toContainText("arc");
});

test("manual issuance preserves Vow without an available solver quote", async ({ page }) => {
  await page.route("**/quote/request", (route) => route.fulfill({ json: { quotes: [] } }));
  await prepareForm(page);
  await page.locator("#verified-by").selectOption("vow");
  await page.evaluate(
    async ({ tx }) => {
      const { default: store } = await import("/src/lib/state.svelte.ts");
      store.outputTokens[0].amount = 90n;
      store.setWalletToCorrectChain = async () => {};
      store.forceUpdate = async () => {};
      store.walletClient = {
        getChainId: async () => 8453,
        switchChain: async () => {},
        writeContract: async ({ functionName, args }) => {
          if (functionName !== "open") throw new Error("Unexpected wallet write");
          window.vowIssuedOrder = args[0];
          return tx;
        }
      };
    },
    { tx }
  );
  await expect(page.getByTestId("quote-button")).toHaveText("No Quote");
  await page.getByRole("button", { name: "Execute Open" }).click();
  await expect.poll(() => page.evaluate(() => window.vowIssuedOrder?.inputOracle)).toBe(adapter);
  expect(await page.evaluate(() => window.vowIssuedOrder.outputs[0].oracle)).toBe(
    addressToBytes32(adapter)
  );
  expect(await page.evaluate(() => window.vowIssuedOrder.outputs[0].amount.toString())).toBe("90");
});

for (const scenario of ["success", "ambiguous", "simulation failure", "already proven"] as const) {
  test(`manual Vow settlement: ${scenario}`, async ({ page }) => {
    const intent = new Intent(
      {
        account: user,
        verifier: "vow",
        lock: { type: "escrow" },
        inputTokens: [
          { token: { address: token, name: "usdc", decimals: 6, chainId: 1n }, amount: 100n }
        ],
        outputTokens: [
          { token: { address: token, name: "usdc", decimals: 6, chainId: 8453n }, amount: 90n }
        ]
      },
      { getOracle: () => adapter }
    ).order();
    const order = intent.asOrder();
    const output = order.outputs[0];
    const timestamp = Math.floor(Date.now() / 1000);
    const eventAbi = COIN_FILLER_ABI.find(
      (entry) => entry.type === "event" && entry.name === "OutputFilled"
    )!;
    const data = encodeAbiParameters(
      eventAbi.inputs.filter((entry) => !entry.indexed),
      [addressToBytes32(user), timestamp, output, output.amount]
    );
    const topics = encodeEventTopics({
      abi: COIN_FILLER_ABI,
      eventName: "OutputFilled",
      args: { orderId: intent.orderId() }
    });
    const canonical = concatHex([
      "0x01",
      filler,
      toHex(topics.length, { size: 1 }),
      ...topics,
      data
    ]);
    const root = keccak256(keccak256(canonical));
    const signer = privateKeyToAccount(`0x${"01".repeat(32)}`);
    const signature = await signer.signTypedData({
      domain: {},
      types: {
        Vow: [
          { name: "chainId", type: "uint256" },
          { name: "rootBlockNumber", type: "uint256" },
          { name: "root", type: "bytes32" }
        ]
      },
      primaryType: "Vow",
      message: { chainId: 8453n, rootBlockNumber: 100n, root }
    });
    const witness = {
      signer: signer.address,
      chainId: "eip155:8453",
      rootBlockNumber: 100,
      root,
      blockHash,
      proof: [],
      signature,
      event: { emitter: filler, topics, data }
    };
    let witnessRequests = 0;
    await page.route("**/vow", async (route) => {
      witnessRequests++;
      expect(route.request().postDataJSON()).toEqual({
        chainId: 8453,
        blockNumber: "100",
        logIndex: 7
      });
      await route.fulfill({ json: { status: "ready", witness, signerIndex: 1 } });
    });
    await page.goto("/");
    const result = await page.evaluate(
      async ({ serialized, inputSettler, data, topics, tx, blockHash, user, signer, scenario }) => {
        const { Solver } = await import("/src/lib/libraries/solver.ts");
        const { getClient } = await import("/src/lib/config.ts");
        const { reviveOrderBigInts } = await import("/src/lib/utils/intent.ts");
        const { default: store } = await import("/src/lib/state.svelte.ts");
        const order = reviveOrderBigInts(JSON.parse(serialized));
        const output = order.outputs[0];
        const container = {
          order,
          inputSettler,
          sponsorSignature: { type: "None", payload: "0x" },
          allocatorSignature: { type: "None", payload: "0x" }
        };
        let proven = scenario === "already proven";
        const writes: string[] = [];
        const receipts: string[] = [];
        let postHooks = 0;
        let simulations = 0;
        const log = {
          address: "0x75220B7600c300005038432a0000f308e0000068",
          data,
          topics,
          blockNumber: 100n,
          blockHash,
          logIndex: 7,
          transactionIndex: 0,
          transactionHash: tx,
          removed: false
        };
        const receipt = {
          status: "success",
          blockNumber: 100n,
          blockHash,
          transactionHash: tx,
          logs: scenario === "ambiguous" ? [log, { ...log, logIndex: 8 }] : [log]
        };
        store.saveTransactionReceipt = async (_chain, hash) => {
          receipts.push(hash);
        };
        const source = getClient(1);
        const destination = getClient(8453);
        destination.getTransactionReceipt = async () => receipt;
        destination.waitForTransactionReceipt = async () => receipt;
        destination.readContract = async () => 999999n;
        source.waitForTransactionReceipt = async () => receipt;
        source.readContract = async ({ functionName }) =>
          functionName === "isProven"
            ? proven
            : functionName === "directory"
              ? "0x108214A3f47A99f9b4f27c7f16CC9B7136653420"
              : signer;
        source.call = async () => {
          simulations++;
          if (scenario === "simulation failure") throw new Error("simulation reverted");
          return { data: "0x" };
        };
        let walletChainId = 1;
        const wallet = {
          getChainId: async () => walletChainId,
          writeContract: async ({ functionName }) => {
            writes.push(functionName);
            if (functionName === "receiveMessage") proven = true;
            return tx;
          }
        };
        const opts = {
          preHook: async (chainId: number) => {
            walletChainId = chainId;
          },
          account: () => user,
          postHook: async () => {
            postHooks++;
          }
        };
        try {
          if (scenario === "success")
            await Solver.fill(wallet, { orderContainer: container, outputs: [output] }, opts)();
          const validate = Solver.validate(
            wallet,
            {
              output,
              orderContainer: container,
              fillTransactionHash: tx,
              sourceChainId: 1,
              mainnet: true
            },
            opts
          );
          await Promise.all([validate(), validate()]);
          if (scenario === "success") {
            await validate();
            await Solver.claim(
              wallet,
              { orderContainer: container, fillTransactionHashes: [tx], sourceChainId: 1 },
              opts
            )();
          }
          return { writes, receipts, postHooks, simulations, error: null };
        } catch (error) {
          return { writes, receipts, postHooks, simulations, error: String(error) };
        }
      },
      {
        serialized: JSON.stringify(order, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value
        ),
        inputSettler: intent.inputSettler,
        data,
        topics,
        tx,
        blockHash,
        user,
        signer: signer.address,
        scenario
      }
    );
    if (scenario === "success") {
      expect(result.error).toBeNull();
      expect(result.writes).toEqual(["fillOrderOutputs", "receiveMessage", "finalise"]);
      expect(result.receipts).toHaveLength(3);
      expect(result.simulations).toBe(1);
      expect(witnessRequests).toBe(1);
    } else if (scenario === "already proven") {
      expect(result.error).toBeNull();
      expect(result.writes).toEqual([]);
      expect(witnessRequests).toBe(0);
    } else {
      expect(result.error).toContain(
        scenario === "ambiguous" ? "Ambiguous fill" : "simulation reverted"
      );
      expect(result.writes).toEqual([]);
    }
  });
}
