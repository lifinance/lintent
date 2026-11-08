import { describe, expect, it } from "bun:test";
import { COIN_FILLER, SOLANA_MAINNET_CHAIN_ID, addressToBytes32 } from "@lifi/intent";
import { AXELAR_ORACLE } from "../../src/lib/config";
import {
  AXELAR_NETWORKS,
  STELLAR_TESTNET_ID,
  stellarContractHex
} from "../../src/lib/axelarNetworks";
import {
  axelarSubmitRoute,
  evmAxelarSubmitData,
  stellarAxelarSubmitArgs
} from "../../src/lib/libraries/axelarSubmit";
import {
  MAX_FILL_DESCRIPTION_BODY,
  MAX_RELAY_PAYLOAD_BYTES,
  assertCleanAccountFiller,
  assertRelayPayloads,
  assertRelayableFillDescription,
  relaysFillDescription
} from "../../src/lib/libraries/fillGuards";
import { fileURLToPath } from "node:url";
import { StrKey } from "@stellar/stellar-sdk";
import { CHAIN_ID_ARBITRUM, CHAIN_ID_BASE, CHAIN_ID_ETHEREUM } from "../fixtures/orderFixtures";

const CLEAN = addressToBytes32("0x2222222222222222222222222222222222222222");
const DIRTY = `0x${"ab".repeat(32)}` as `0x${string}`;
const bytes = (count: number) => `0x${"11".repeat(count)}` as `0x${string}`;
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/fillGuardEntries.ts", import.meta.url));

describe("fill description limits", () => {
  it("accepts a body of 65367 bytes and rejects one more", () => {
    expect(() =>
      assertRelayableFillDescription({
        callbackData: bytes(MAX_FILL_DESCRIPTION_BODY),
        context: "0x"
      })
    ).not.toThrow();
    expect(() =>
      assertRelayableFillDescription({
        callbackData: bytes(60_000),
        context: bytes(MAX_FILL_DESCRIPTION_BODY - 60_000)
      })
    ).not.toThrow();
    expect(() =>
      assertRelayableFillDescription({
        callbackData: bytes(60_000),
        context: bytes(MAX_FILL_DESCRIPTION_BODY - 60_000 + 1)
      })
    ).toThrow(String(MAX_FILL_DESCRIPTION_BODY));
  });

  it("rejects a relay payload longer than a uint16", () => {
    expect(() => assertRelayPayloads([bytes(MAX_RELAY_PAYLOAD_BYTES)])).not.toThrow();
    expect(() => assertRelayPayloads([bytes(MAX_RELAY_PAYLOAD_BYTES + 1)])).toThrow(
      String(MAX_RELAY_PAYLOAD_BYTES)
    );
  });

  it("treats Axelar and cross-chain Solana as relayed, and same-chain Solana as local", () => {
    const axelar = AXELAR_ORACLE[Number(CHAIN_ID_BASE)]!;
    expect(
      relaysFillDescription(
        { inputOracle: axelar, originChainId: CHAIN_ID_BASE },
        CHAIN_ID_ARBITRUM
      )
    ).toBe(true);
    expect(
      relaysFillDescription(
        { inputOracle: axelar, originChainId: CHAIN_ID_ETHEREUM },
        SOLANA_MAINNET_CHAIN_ID
      )
    ).toBe(true);
    expect(
      relaysFillDescription(
        {
          inputOracle: "0x1111111111111111111111111111111111111111",
          originChainId: SOLANA_MAINNET_CHAIN_ID
        },
        SOLANA_MAINNET_CHAIN_ID
      )
    ).toBe(false);
    expect(
      relaysFillDescription(
        {
          inputOracle: "0x1111111111111111111111111111111111111111",
          originChainId: CHAIN_ID_ETHEREUM
        },
        SOLANA_MAINNET_CHAIN_ID
      )
    ).toBe(true);
  });

  it("accepts a left-padded account and rejects high bits", () => {
    expect(() => assertCleanAccountFiller(CLEAN)).not.toThrow();
    expect(() => assertCleanAccountFiller(DIRTY)).toThrow(/left-padded/);
  });
});

describe("fill and submit entry points", () => {
  it("rejects a dirty solver and an unrelayable description before any wallet or proof read", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", fixture], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp"
      },
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);
    if (status !== 0) throw new Error(stderr || stdout);
    const report = JSON.parse(stdout) as Record<string, string>;
    expect(report.dirty).toContain("left-padded");
    expect(report.axelarFill).toContain(String(MAX_FILL_DESCRIPTION_BODY));
    expect(report.axelarProof).toContain(String(MAX_FILL_DESCRIPTION_BODY));
    expect(report.polymerFill).toBe("wallet-reached");
    expect(report.solanaSubmit).toContain(String(MAX_FILL_DESCRIPTION_BODY));
  });

  it("rejects an oversized payload in both Axelar submit encoders", () => {
    const payload = bytes(MAX_RELAY_PAYLOAD_BYTES + 1);
    const route = axelarSubmitRoute(
      84532,
      STELLAR_TESTNET_ID,
      stellarContractHex(AXELAR_NETWORKS.testnet.stellar.oracle)
    );
    expect(() => evmAxelarSubmitData(route, COIN_FILLER, [payload])).toThrow(
      String(MAX_RELAY_PAYLOAD_BYTES)
    );
    const payer = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4));
    expect(() =>
      stellarAxelarSubmitArgs(route, {
        source: payer,
        payer,
        payloads: [payload],
        gasAmount: 1n
      })
    ).toThrow(String(MAX_RELAY_PAYLOAD_BYTES));
  });
});
