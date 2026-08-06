import { describe, expect, it } from "bun:test";
import type { EVMOrder, MandateOutput } from "@lifi/intent";
import { addressToBytes32, BYTES32_ZERO } from "@lifi/intent";
import type { StandardEVMIntent } from "@lifi/intent";
import {
  TRON_MAINNET_GENESIS_BLOCK_ID,
  assertTronMainnet,
  invalidateNetworkGuardCache,
  waitForTronTransaction
} from "../../src/lib/tron/signer";
import { fillOutputs, finalise, openEscrow } from "../../src/lib/tron/writes";
import type { TronTxInfo, TronWebLike } from "../../src/lib/tron/types";

const USDT = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c" as const;
const SOLVER = "0x2222222222222222222222222222222222222222" as const;
const SETTLER = "0x784d4f7b6e99b22d923ec99edbe2e11b38ceac93" as const;

type Call = { contract: string; method: string; args: unknown[]; opts?: Record<string, unknown> };

function makeMock(opts: {
  genesis?: string;
  allowance?: bigint;
  defaultAddress?: { base58: string; hex: string };
  txInfoScript?: (id: string, attempt: number) => TronTxInfo;
}): { tw: TronWebLike; calls: Call[] } {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  let txCounter = 0;
  const tw: TronWebLike = {
    ready: true,
    defaultAddress: opts.defaultAddress ?? { base58: "TSolver", hex: `41${SOLVER.slice(2)}` },
    trx: {
      async getBalance() {
        return 0;
      },
      async getTransactionInfo(id: string) {
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        if (opts.txInfoScript) return opts.txInfoScript(id, attempt);
        return { blockNumber: 1, receipt: { result: "SUCCESS" } };
      },
      async getTransaction() {
        return {};
      },
      async getBlockByNumber(n: number) {
        if (n === 0) return { blockID: opts.genesis ?? TRON_MAINNET_GENESIS_BLOCK_ID };
        return {};
      }
    },
    async contract(_abi: unknown[], address: string) {
      const instance = new Proxy(
        {},
        {
          get(_target, method: string | symbol) {
            // Returning a function for "then" would make the proxy a thenable
            // that never settles when awaited.
            if (typeof method !== "string" || method === "then") return undefined;
            return (...args: unknown[]) => ({
              send: async (sendOpts?: Record<string, unknown>) => {
                calls.push({ contract: address, method, args, opts: sendOpts });
                return `tx${++txCounter}`;
              },
              call: async () => {
                calls.push({ contract: address, method, args });
                if (method === "allowance") return opts.allowance ?? 0n;
                return 0n;
              }
            });
          }
        }
      );
      return instance as never;
    },
    address: {
      fromHex: (hex: string) => `b58:${hex}`,
      toHex: (b58: string) => b58.replace("b58:", "")
    }
  };
  return { tw, calls };
}

function makeOutput(overrides: Partial<MandateOutput> = {}): MandateOutput {
  return {
    oracle: addressToBytes32("0x94b0c01e26aff5a6a0fd767afe0e3ca0f8b34e3d"),
    settler: addressToBytes32(SETTLER),
    chainId: 728126428n,
    token: addressToBytes32(USDT),
    amount: 1_000_000n,
    recipient: addressToBytes32("0x1111111111111111111111111111111111111111"),
    callbackData: "0x",
    context: "0x",
    ...overrides
  };
}

describe("assertTronMainnet", () => {
  it("accepts the mainnet genesis and rejects others", async () => {
    invalidateNetworkGuardCache();
    const { tw } = makeMock({});
    await assertTronMainnet(tw);

    const nile = makeMock({ genesis: "00".repeat(32) });
    await expect(assertTronMainnet(nile.tw)).rejects.toThrow("non-mainnet");
  });

  it("rejects when signer and reads disagree", async () => {
    invalidateNetworkGuardCache();
    const signer = makeMock({});
    const reads = makeMock({ genesis: "11".repeat(32) });
    await expect(assertTronMainnet(signer.tw, reads.tw)).rejects.toThrow("different networks");
  });
});

describe("waitForTronTransaction", () => {
  it("treats empty info as not mined, then succeeds", async () => {
    const { tw } = makeMock({
      txInfoScript: (_id, attempt) =>
        attempt < 3 ? {} : { blockNumber: 9, receipt: { result: "SUCCESS" } }
    });
    const info = await waitForTronTransaction(tw, "abc", { intervalMs: 1 });
    expect(info.blockNumber).toBe(9);
  });

  it.each([
    "REVERT",
    "OUT_OF_ENERGY",
    "OUT_OF_TIME",
    "ILLEGAL_OPERATION",
    "TRANSFER_FAILED"
  ] as const)("throws on any non-SUCCESS receipt result: %s", async (result) => {
    const { tw } = makeMock({
      txInfoScript: () => ({
        blockNumber: 9,
        receipt: { result },
        resMessage: Buffer.from("boom").toString("hex")
      })
    });
    await expect(waitForTronTransaction(tw, "abc", { intervalMs: 1 })).rejects.toThrow(
      new RegExp(`${result}.*boom`)
    );
  });

  it("throws on top-level FAILED", async () => {
    const { tw } = makeMock({
      txInfoScript: () => ({ blockNumber: 9, result: "FAILED" })
    });
    await expect(waitForTronTransaction(tw, "abc", { intervalMs: 1 })).rejects.toThrow("failed");
  });

  it("times out when never mined", async () => {
    const { tw } = makeMock({ txInfoScript: () => ({}) });
    await expect(
      waitForTronTransaction(tw, "abc", { intervalMs: 1, timeoutMs: 20 })
    ).rejects.toThrow("Timed out");
  });

  it("inclusion mode prefers the full-node (unconfirmed) endpoint when available", async () => {
    let unconfirmedPolls = 0;
    let solidityPolls = 0;
    const { tw } = makeMock({
      txInfoScript: () => {
        solidityPolls += 1;
        return { blockNumber: 9, receipt: { result: "SUCCESS" } };
      }
    });
    tw.trx.getUnconfirmedTransactionInfo = async () => {
      unconfirmedPolls += 1;
      return { blockNumber: 9, receipt: { result: "SUCCESS" } };
    };
    await waitForTronTransaction(tw, "abc", { mode: "inclusion", intervalMs: 1 });
    expect(unconfirmedPolls).toBe(1);
    expect(solidityPolls).toBe(0);

    // confirmed mode must use the solidity endpoint (irreversible data only).
    await waitForTronTransaction(tw, "abc", { mode: "confirmed", intervalMs: 1 });
    expect(solidityPolls).toBe(1);
  });
});

describe("fillOutputs", () => {
  it("approves before filling when allowance is insufficient", async () => {
    invalidateNetworkGuardCache();
    const { tw, calls } = makeMock({ allowance: 0n });
    const deps = { reads: tw, signer: tw };
    await fillOutputs(deps, {
      orderId: `0x${"11".repeat(32)}`,
      outputs: [makeOutput()],
      fillDeadline: 1234,
      solverBytes32: addressToBytes32(SOLVER)
    });
    const methods = calls.map((c) => c.method);
    expect(methods.indexOf("approve")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("approve")).toBeLessThan(methods.indexOf("fillOrderOutputs"));
  });

  it("skips approval when allowance suffices and passes fillerData + deadline", async () => {
    invalidateNetworkGuardCache();
    const { tw, calls } = makeMock({ allowance: 10_000_000n });
    await fillOutputs(
      { reads: tw, signer: tw },
      {
        orderId: `0x${"11".repeat(32)}`,
        outputs: [makeOutput()],
        fillDeadline: 1234,
        solverBytes32: addressToBytes32(SOLVER)
      }
    );
    expect(calls.some((c) => c.method === "approve")).toBe(false);
    const fill = calls.find((c) => c.method === "fillOrderOutputs")!;
    expect(fill.args[2]).toBe(1234);
    expect(fill.args[3]).toBe(addressToBytes32(SOLVER));
    expect(fill.opts?.callValue).toBeUndefined();
  });

  it("attaches callValue for native limit outputs and skips their approval", async () => {
    invalidateNetworkGuardCache();
    const { tw, calls } = makeMock({ allowance: 10_000_000n });
    await fillOutputs(
      { reads: tw, signer: tw },
      {
        orderId: `0x${"11".repeat(32)}`,
        outputs: [
          makeOutput({ token: BYTES32_ZERO, amount: 3_000_000n }),
          makeOutput({
            token: BYTES32_ZERO,
            amount: 2_000_000n,
            context: `0xe0${"00".repeat(36)}` as `0x${string}`
          })
        ],
        fillDeadline: 1234,
        solverBytes32: addressToBytes32(SOLVER)
      }
    );
    expect(calls.some((c) => c.method === "approve")).toBe(false);
    const fill = calls.find((c) => c.method === "fillOrderOutputs")!;
    expect(fill.opts?.callValue).toBe(5_000_000);
  });

  it("rejects native outputs with auction contexts", async () => {
    invalidateNetworkGuardCache();
    const { tw } = makeMock({ allowance: 10_000_000n });
    await expect(
      fillOutputs(
        { reads: tw, signer: tw },
        {
          orderId: `0x${"11".repeat(32)}`,
          outputs: [
            makeOutput({ token: BYTES32_ZERO, context: `0x01${"00".repeat(40)}` as `0x${string}` })
          ],
          fillDeadline: 1234,
          solverBytes32: addressToBytes32(SOLVER)
        }
      )
    ).rejects.toThrow("auction");
  });

  it("hard-blocks on a non-mainnet signer", async () => {
    invalidateNetworkGuardCache();
    const { tw } = makeMock({ genesis: "22".repeat(32) });
    await expect(
      fillOutputs(
        { reads: tw, signer: tw },
        {
          orderId: `0x${"11".repeat(32)}`,
          outputs: [makeOutput()],
          fillDeadline: 1234,
          solverBytes32: addressToBytes32(SOLVER)
        }
      )
    ).rejects.toThrow("non-mainnet");
  });
});

describe("openEscrow", () => {
  const order: EVMOrder = {
    user: SOLVER,
    nonce: 1n,
    originChainId: 728126428n,
    expires: 2_000_000_000,
    fillDeadline: 1_999_999_000,
    inputOracle: "0x94b0c01e26aff5a6a0fd767afe0e3ca0f8b34e3d",
    inputs: [
      [BigInt(USDT), 4n],
      [0n, 6n] // native TRX input
    ],
    outputs: [makeOutput()]
  };
  const intent = {
    inputSettler: "0xaa2e58aa1a4107dc8cc7ef41b97be90b25b5b842",
    asOrder: () => order
  } as unknown as StandardEVMIntent;

  it("rejects when the signer does not match order.user", async () => {
    invalidateNetworkGuardCache();
    const { tw } = makeMock({
      defaultAddress: { base58: "TOther", hex: `41${"33".repeat(20)}` }
    });
    await expect(openEscrow({ reads: tw, signer: tw }, intent)).rejects.toThrow(
      "does not match the order's user"
    );
  });

  it("approves TRC-20 inputs before open and attaches native callValue", async () => {
    invalidateNetworkGuardCache();
    const { tw, calls } = makeMock({ allowance: 0n });
    await openEscrow({ reads: tw, signer: tw }, intent);
    const methods = calls.map((c) => c.method);
    expect(methods.indexOf("approve")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("approve")).toBeLessThan(methods.indexOf("open"));
    const open = calls.find((c) => c.method === "open")!;
    expect(open.opts?.callValue).toBe(6);
  });
});

describe("finalise ownership check", () => {
  it("rejects when the connected account is not the recorded solver", async () => {
    invalidateNetworkGuardCache();
    const { tw } = makeMock({
      defaultAddress: { base58: "TOther", hex: `41${"33".repeat(20)}` }
    });
    await expect(
      finalise(
        { reads: tw, signer: tw },
        {
          inputSettler: "0xaa2e58aa1a4107dc8cc7ef41b97be90b25b5b842",
          order: {
            user: SOLVER,
            nonce: 1n,
            originChainId: 728126428n,
            expires: 2_000_000_000,
            fillDeadline: 1_999_999_000,
            inputOracle: "0x94b0c01e26aff5a6a0fd767afe0e3ca0f8b34e3d",
            inputs: [[BigInt(USDT), 4n]],
            outputs: [makeOutput()]
          },
          solveParams: [{ timestamp: 1234, solver: addressToBytes32(SOLVER) }],
          destinationBytes32: addressToBytes32(SOLVER)
        }
      )
    ).rejects.toThrow("connect that wallet");
  });

  it("finalises when the connected account matches the recorded solver", async () => {
    invalidateNetworkGuardCache();
    const { tw, calls } = makeMock({});
    await finalise(
      { reads: tw, signer: tw },
      {
        inputSettler: "0xaa2e58aa1a4107dc8cc7ef41b97be90b25b5b842",
        order: {
          user: SOLVER,
          nonce: 1n,
          originChainId: 728126428n,
          expires: 2_000_000_000,
          fillDeadline: 1_999_999_000,
          inputOracle: "0x94b0c01e26aff5a6a0fd767afe0e3ca0f8b34e3d",
          inputs: [[BigInt(USDT), 4n]],
          outputs: [makeOutput()]
        },
        solveParams: [{ timestamp: 1234, solver: addressToBytes32(SOLVER) }],
        destinationBytes32: addressToBytes32(SOLVER)
      }
    );
    const fin = calls.find((c) => c.method === "finalise")!;
    expect(fin.args[1]).toEqual([[1234, addressToBytes32(SOLVER)]]);
    expect(fin.args[3]).toBe("0x");
  });
});
