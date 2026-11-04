import { describe, expect, it } from "bun:test";
import { Intent, stellarStrkeyToBytes32 } from "@lifi/intent";
import { StrKey } from "@stellar/stellar-sdk";
import {
  AXELAR_NETWORKS,
  STELLAR_TESTNET_ID,
  stellarContractHex
} from "../../src/lib/axelarNetworks";
import { stellarRouteProblem } from "../../src/lib/libraries/apiQuote";
import { intentDeps } from "../../src/lib/libraries/coreDeps";

const { testnet } = AXELAR_NETWORKS;
const BASE_SEPOLIA = 84532;
const evmUsdc = testnet.evm[BASE_SEPOLIA]!.usdc;
const stellarUsdc = stellarContractHex(testnet.stellar.usdc);
const token = (chainId: number, address: `0x${string}`, decimals: number) => ({
  token: { chainId, address, decimals, name: "usdc" },
  amount: 1_000_000n
});
const route = {
  inputs: [token(BASE_SEPOLIA, evmUsdc, 6)],
  outputs: [token(STELLAR_TESTNET_ID, stellarUsdc, 7)],
  mainnet: false,
  verifier: "axelar",
  lockType: "escrow" as const
};

describe("stellarRouteProblem (shared by manual and quoted orders)", () => {
  it("accepts the configured USDC corridor", () => {
    expect(stellarRouteProblem(route)).toBeUndefined();
  });
  it("ignores routes that don't touch Stellar", () => {
    expect(
      stellarRouteProblem({ ...route, outputs: [token(8453, evmUsdc, 6)], lockType: "compact" })
    ).toBeUndefined();
  });
  it("rejects what the corridor can't carry", () => {
    expect(stellarRouteProblem({ ...route, lockType: "compact" })).toMatch(/escrow/);
    expect(stellarRouteProblem({ ...route, verifier: "polymer" })).toMatch(/Axelar/);
    expect(stellarRouteProblem({ ...route, mainnet: true })).toMatch(/Testnet/);
    expect(
      stellarRouteProblem({ ...route, inputs: [token(BASE_SEPOLIA, `0x${"11".repeat(20)}`, 6)] })
    ).toMatch(/USDC/);
    expect(
      stellarRouteProblem({ ...route, outputs: [token(STELLAR_TESTNET_ID, stellarUsdc, 6)] })
    ).toMatch(/USDC/);
  });
});

describe("manual EVM → Stellar order encoding", () => {
  const recipient = stellarStrkeyToBytes32(StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7)));
  const solver = `0x${"ab".repeat(20)}` as const;
  const build = (exclusiveFor?: `0x${string}`) => {
    const intent = new Intent(
      {
        exclusiveFor,
        inputTokens: route.inputs.map((t) => ({
          ...t,
          token: { ...t.token, chainId: BigInt(t.token.chainId), chainNamespace: "eip155" }
        })),
        outputTokens: route.outputs.map((t) => ({
          ...t,
          token: { ...t.token, chainId: BigInt(t.token.chainId), chainNamespace: "stellar" }
        })),
        verifier: "axelar",
        account: `0x${"cd".repeat(20)}`,
        outputRecipient: recipient,
        lock: { type: "escrow" }
      },
      intentDeps
    );
    intent.setExclusivity(300);
    return intent.order().asOrder();
  };

  it("tags the recipient as a Stellar account", () => {
    expect(build().outputs[0].context).toBe("0x00");
  });
  it("keeps the account tag after the exclusive context", () => {
    const before = Math.floor(Date.now() / 1000);
    const context = build(solver).outputs[0].context;
    // 0xe0 · solver (bytes32) · uint32 deadline · 0x00 recipient tag
    expect(context.length).toBe(2 + 2 * (1 + 32 + 4 + 1));
    expect(context.slice(0, 4)).toBe("0xe0");
    expect(context.slice(4, 68)).toBe(`${"00".repeat(12)}${solver.slice(2)}`);
    const deadline = parseInt(context.slice(68, 76), 16);
    expect(deadline).toBeGreaterThanOrEqual(before + 300);
    expect(deadline).toBeLessThanOrEqual(before + 302);
    expect(context.slice(76)).toBe("00");
  });
});
