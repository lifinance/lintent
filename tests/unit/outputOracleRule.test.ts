import { describe, expect, test } from "bun:test";
import {
  Intent,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_OUTPUT_SETTLER_PDA,
  SOLANA_POLYMER_ORACLE_PDA,
  SOLANA_POLYMER_ORACLE_PROGRAM,
  COIN_FILLER,
  TRON_MAINNET_OUTPUT_SETTLER,
  addressToBytes32,
  validateOrderWithReason,
  type CoreToken,
  type StandardOrder
} from "@lifi/intent";
import { arbitrum, base, tron } from "viem/chains";
import { POLYMER_ORACLE } from "../../src/lib/config";
import { intentDeps, orderValidationDeps } from "../../src/lib/libraries/coreDeps";
import { namespaceForChain } from "../../src/lib/utils/chainType";
import { TEST_USER, b32 } from "../fixtures/orderFixtures";

/**
 * The cross-repo contract for `MandateOutput.oracle`.
 *
 * The value is chosen by `@lifi/intent`'s `buildMandateOutputs` and then
 * re-checked by this app's `orderValidationDeps`. Nothing else pins the two
 * together, so a drift between the repos is only visible here: each route
 * asserts the emitted bytes AND that the app's own validator accepts them.
 */
const token = (address: string, chainId: bigint, decimals = 6): CoreToken => ({
  address: address as `0x${string}`,
  name: "usdc",
  chainId,
  decimals,
  chainNamespace: namespaceForChain(chainId)
});

const EVM_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOLANA_USDC = b32("a");
const TRON_USDC = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";

const BASE = token(EVM_USDC, BigInt(base.id));
const ARBITRUM = token(EVM_USDC, BigInt(arbitrum.id));
const SOLANA = token(SOLANA_USDC, SOLANA_MAINNET_CHAIN_ID, 9);
const TRON = token(TRON_USDC, BigInt(tron.id));

function build(input: CoreToken, output: CoreToken): StandardOrder {
  const intent = new Intent(
    {
      inputTokens: [{ token: input, amount: 1_000_000n }],
      outputTokens: [{ token: output, amount: 1_000_000n }],
      verifier: "polymer",
      account: TEST_USER,
      // Required whenever the output namespace differs from the input's.
      outputRecipient: b32("c"),
      lock: { type: "escrow" }
    },
    intentDeps
  );
  return intent.singlechain().asOrder() as StandardOrder;
}

const cases: {
  name: string;
  input: CoreToken;
  output: CoreToken;
  oracle: `0x${string}`;
  settler: `0x${string}`;
}[] = [
  {
    name: "Base -> Arbitrum names the input chain's oracle",
    input: BASE,
    output: ARBITRUM,
    oracle: addressToBytes32(POLYMER_ORACLE[base.id]!),
    settler: addressToBytes32(COIN_FILLER)
  },
  {
    name: "Solana -> Base names the OUTPUT chain's oracle",
    input: SOLANA,
    output: BASE,
    oracle: addressToBytes32(POLYMER_ORACLE[base.id]!),
    settler: addressToBytes32(COIN_FILLER)
  },
  {
    name: "Solana -> Tron names the Tron oracle, not the EVM one",
    input: SOLANA,
    output: TRON,
    oracle: addressToBytes32(POLYMER_ORACLE[tron.id]!),
    settler: addressToBytes32(TRON_MAINNET_OUTPUT_SETTLER)
  },
  {
    name: "Base -> Solana still names the polymer PROGRAM ID",
    input: BASE,
    output: SOLANA,
    oracle: SOLANA_POLYMER_ORACLE_PROGRAM,
    settler: SOLANA_OUTPUT_SETTLER_PDA
  },
  {
    name: "Tron -> Base names the Tron input oracle",
    input: TRON,
    output: BASE,
    oracle: addressToBytes32(POLYMER_ORACLE[tron.id]!),
    settler: addressToBytes32(COIN_FILLER)
  },
  {
    name: "Base -> Tron names the EVM input oracle",
    input: BASE,
    output: TRON,
    oracle: addressToBytes32(POLYMER_ORACLE[base.id]!),
    settler: addressToBytes32(TRON_MAINNET_OUTPUT_SETTLER)
  },
  {
    name: "Base -> Base uses the output settler as the oracle",
    input: BASE,
    output: BASE,
    oracle: addressToBytes32(COIN_FILLER),
    settler: addressToBytes32(COIN_FILLER)
  },
  {
    name: "Solana -> Solana uses the output settler as the oracle",
    input: SOLANA,
    output: SOLANA,
    oracle: SOLANA_OUTPUT_SETTLER_PDA,
    settler: SOLANA_OUTPUT_SETTLER_PDA
  }
];

describe("MandateOutput.oracle per route", () => {
  for (const c of cases) {
    test(c.name, () => {
      const order = build(c.input, c.output);
      const output = order.outputs[0]!;

      expect(output.oracle).toBe(c.oracle);
      expect(output.settler).toBe(c.settler);

      const result = validateOrderWithReason({ order, deps: orderValidationDeps });
      expect(result.reason ?? "").toBe("");
      expect(result.passed).toBe(true);
    });
  }

  test("no EVM output ever carries a dirty 32-byte oracle", () => {
    // The revert this guards: OutputSettlerBase._fill calls
    // validatedCleanAddress(output.oracle) and reverts HasDirtyBits() on any
    // value with non-zero upper 12 bytes, so an EVM/Tron output must always be
    // a zero-padded address.
    for (const output of [BASE, ARBITRUM, TRON]) {
      for (const input of [BASE, SOLANA, TRON]) {
        const order = build(input, output);
        expect(order.outputs[0]!.oracle.slice(0, 26)).toBe(`0x${"00".repeat(12)}`);
      }
    }
  });

  test("the solana input oracle itself is dirty, which is why it cannot be reused", () => {
    expect(SOLANA_POLYMER_ORACLE_PDA.slice(0, 26)).not.toBe(`0x${"00".repeat(12)}`);
  });
});
