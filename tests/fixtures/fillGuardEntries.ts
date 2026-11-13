import { mock } from "bun:test";
import { COIN_FILLER, SOLANA_MAINNET_CHAIN_ID } from "@lifi/intent";
import { AXELAR_ORACLE } from "../../src/lib/config";
import { MAX_FILL_DESCRIPTION_BODY } from "../../src/lib/libraries/fillGuards";
import type { SolanaDeps } from "../../src/lib/solana/types";
import type { WC } from "../../src/lib/config";
import {
  CHAIN_ID_ARBITRUM,
  CHAIN_ID_BASE,
  makeMandateOutput,
  makeStandardOrder
} from "./orderFixtures";

const DIRTY = `0x${"ab".repeat(32)}` as `0x${string}`;
const FILL_TX = `0x${"cd".repeat(32)}`;
const bytes = (count: number) => `0x${"11".repeat(count)}` as `0x${string}`;
const account = () => "0x2222222222222222222222222222222222222222" as `0x${string}`;

function walletThatShouldNotRun(): WC {
  return {
    getChainId: async () => {
      throw new Error("wallet-reached");
    }
  } as WC;
}

function container(order = makeStandardOrder()) {
  return { order, inputSettler: COIN_FILLER };
}

async function message(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "no-throw";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function runFillGuardEntries() {
  mock.module("$app/environment", () => ({
    browser: false,
    building: false,
    dev: true,
    version: "test"
  }));
  mock.module("$env/dynamic/public", () => ({ env: {} }));
  const store = {
    connectedAccount: { address: account() },
    stellarAccounts: {},
    transactionReceipts: {},
    saveTransactionReceipt: async () => {},
    getTransactionReceipt: () => undefined,
    saveStellarTransaction: async () => {},
    getStellarTransaction: () => undefined
  };
  mock.module("../../src/lib/state.svelte", () => ({ default: store, store }));

  const { Solver } = await import("../../src/lib/libraries/solver");
  const { submitFillProof } = await import("../../src/lib/solana/writes");
  const oracle = AXELAR_ORACLE[Number(CHAIN_ID_BASE)]!;
  const oversized = makeMandateOutput(CHAIN_ID_ARBITRUM, 1n, {
    callbackData: bytes(MAX_FILL_DESCRIPTION_BODY + 1)
  });
  const axelarOrder = makeStandardOrder({
    originChainId: CHAIN_ID_BASE,
    inputOracle: oracle,
    outputs: [oversized]
  });

  const dirty = await message(() =>
    Solver.fill(
      walletThatShouldNotRun(),
      { orderContainer: container(), outputs: [makeMandateOutput()] },
      { account, solver: () => DIRTY }
    )()
  );
  const axelarFill = await message(() =>
    Solver.fill(
      walletThatShouldNotRun(),
      { orderContainer: container(axelarOrder), outputs: [oversized] },
      { account }
    )()
  );
  const axelarProof = await message(() =>
    Solver.validate(
      walletThatShouldNotRun(),
      {
        output: oversized,
        orderContainer: container(axelarOrder),
        fillTransactionHash: FILL_TX,
        sourceChainId: Number(CHAIN_ID_BASE),
        mainnet: true
      },
      { account }
    )()
  );
  const polymerFill = await message(() =>
    Solver.fill(
      walletThatShouldNotRun(),
      { orderContainer: container(), outputs: [makeMandateOutput()] },
      { account }
    )()
  );
  const solanaOutput = makeMandateOutput(SOLANA_MAINNET_CHAIN_ID, 1n, {
    context: bytes(MAX_FILL_DESCRIPTION_BODY + 1)
  });
  const solanaSubmit = await message(() =>
    submitFillProof({} as SolanaDeps, {
      orderId: `0x${"12".repeat(32)}`,
      output: solanaOutput,
      solverBytes32: DIRTY,
      timestamp: 1
    })
  );

  return { dirty, axelarFill, axelarProof, polymerFill, solanaSubmit };
}

if (import.meta.main) {
  runFillGuardEntries()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    });
}
