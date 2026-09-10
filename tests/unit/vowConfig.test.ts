import { describe, expect, it } from "bun:test";
import {
  Intent,
  addressToBytes32,
  validateOrderWithReason,
  SOLANA_MAINNET_CHAIN_ID,
  type StandardOrder
} from "@lifi/intent";
import {
  VOW_ADAPTER,
  VOW_ORACLE,
  coinList,
  chainList,
  getChain,
  getClient,
  INPUT_SETTLER_ESCROW_LIFI
} from "../../src/lib/config";
import { intentDeps, orderValidationDeps } from "../../src/lib/libraries/coreDeps";
import {
  oracleSelectionProblem,
  quoteOracleSelection
} from "../../src/lib/libraries/oracleSelection";
import { TEST_USER, makeStandardOrder, makeMandateOutput } from "../fixtures/orderFixtures";
import { reviveOrderBigInts } from "../../src/lib/utils/intent";

const chains = [1, 42161, 56, 8453, 4663, 5042];
const token = (chainId: number) => ({
  address: TEST_USER,
  name: "usdc",
  chainId: BigInt(chainId),
  decimals: 6,
  chainNamespace: "eip155" as const
});

describe("Vow route configuration", () => {
  it("covers all six EVM deployments in both directions", () => {
    expect(Object.keys(VOW_ORACLE).map(Number).sort()).toEqual([...chains].sort());
    for (const from of chains)
      for (const to of chains) {
        expect(oracleSelectionProblem("vow", [from], [to])).toBeUndefined();
        const intent = new Intent(
          {
            account: TEST_USER,
            inputTokens: [{ token: token(from), amount: 100n }],
            outputTokens: [{ token: token(to), amount: 90n }],
            verifier: "vow",
            lock: { type: "escrow" }
          },
          intentDeps
        ).order();
        const order = intent.asOrder() as StandardOrder;
        if (from !== to) {
          expect(order.inputOracle).toBe(VOW_ADAPTER);
          expect(order.outputs[0].oracle).toBe(addressToBytes32(VOW_ADAPTER));
        }
        expect(validateOrderWithReason({ order, deps: orderValidationDeps }).passed).toBe(true);
        expect(intent.inputSettler).toBe(INPUT_SETTLER_ESCROW_LIFI);
      }
  });
  it("rejects mixed namespaces and unsupported Vow chains", () => {
    for (const chain of [728126428, Number(SOLANA_MAINNET_CHAIN_ID), 11155111, 5042002]) {
      expect(oracleSelectionProblem("vow", [1], [chain])).toBeDefined();
      expect(oracleSelectionProblem("vow", [chain], [1])).toBeDefined();
      expect(() => quoteOracleSelection("vow", [1], [chain])).toThrow();
    }
  });
  it("deduplicates explicit quote contracts and omits them for same-chain or Polymer", () => {
    expect(quoteOracleSelection("vow", [1, 1n], [8453, 4663])).toEqual([
      { chainId: 1, address: VOW_ADAPTER },
      { chainId: 8453, address: VOW_ADAPTER },
      { chainId: 4663, address: VOW_ADAPTER }
    ]);
    expect(quoteOracleSelection("vow", [1], [1])).toBeUndefined();
    expect(quoteOracleSelection("polymer", [1], [8453])).toBeUndefined();
  });
  it("rejects imported orders with an unmatched oracle or unsupported output", () => {
    for (const chainId of [1n, 8453n, SOLANA_MAINNET_CHAIN_ID, 728126428n, 5042002n]) {
      const order = makeStandardOrder({
        inputOracle: VOW_ADAPTER,
        outputs: [makeMandateOutput(chainId)]
      });
      expect(validateOrderWithReason({ order, deps: orderValidationDeps }).passed).toBe(false);
    }
    const valid = makeStandardOrder({
      inputOracle: VOW_ADAPTER,
      outputs: [makeMandateOutput(8453n, 1n, { oracle: addressToBytes32(VOW_ADAPTER) })]
    });
    expect(validateOrderWithReason({ order: valid, deps: orderValidationDeps }).passed).toBe(true);
    const restored = reviveOrderBigInts(
      JSON.parse(
        JSON.stringify(valid, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value
        )
      )
    ) as StandardOrder;
    expect(restored).toEqual(valid);
    expect(validateOrderWithReason({ order: restored, deps: orderValidationDeps }).passed).toBe(
      true
    );
    const badMulti = { ...valid, outputs: [...valid.outputs, makeMandateOutput(56n)] };
    expect(validateOrderWithReason({ order: badMulti, deps: orderValidationDeps }).passed).toBe(
      false
    );
  });
  it("configures new mainnets and only ERC-20 spend assets", () => {
    expect(chainList(true)).toContain("robinhood");
    expect(chainList(true)).toContain("arc");
    for (const chain of [4663, 5042] as const) {
      expect(getChain(chain).id).toBe(chain);
      expect(getClient(chain).chain?.id).toBe(chain);
      const coins = coinList(true).filter((coin) => coin.chainId === chain);
      expect(coins).toHaveLength(1);
      expect(coins[0].decimals).toBe(6);
      expect(coins[0].address).not.toBe("0x0000000000000000000000000000000000000000");
    }
  });
});
