import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import {
  Intent,
  addressToBytes32,
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
  TRON_LEGACY_POLYMER_ORACLES,
  type MandateOutput,
  type OrderContainer
} from "@lifi/intent";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex
} from "viem";
import {
  clientsById,
  COIN_FILLER,
  POLYMER_ORACLE,
  SOLANA_OUTPUT_SETTLER,
  WORMHOLE_CHAIN_IDS,
  WORMHOLE_CORE,
  WORMHOLE_ORACLE
} from "../../src/lib/config";
import { WORMHOLE_CORE_ABI } from "../../src/lib/abi/wormholecore";
import { WORMHOLE_ORACLE_ABI } from "../../src/lib/abi/wormholeoracle";
import { INTENTS_PROTOCOL_PROGRAM_ID, OUTPUT_SETTLER_SIMPLE_PROGRAM_ID } from "../../src/lib/idl";
import * as solanaClient from "../../src/lib/solana/client";
import { chainMappingPda, polymerOraclePda } from "../../src/lib/solana/pda";
import { CHAIN_MAPPING_DISCRIMINATOR } from "../../src/lib/solana/nonFill";
import type { SolanaAccountInfoLike, SolanaConnectionLike } from "../../src/lib/solana/types";
import {
  assertWormholeOrderReady,
  assertWormholeSelectionReady,
  checkWormholeRoute,
  oracleProviderFor
} from "../../src/lib/libraries/oracleRoute";
import { intentDeps } from "../../src/lib/libraries/coreDeps";
import { namespaceForChain } from "../../src/lib/utils/chainType";

const BASE = 8453;
const ARBITRUM = 42161;
const SOLANA = Number(SOLANA_MAINNET_CHAIN_ID);
const SOLANA_PROGRAM = "LiFixrxyzmt1Degd42wQCsQNhDNLjbrRwtwopX5VUrt";
const SOLANA_CORE = "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth";
const SOLANA_STATE = "AT9CvSMc1pq8SfrXagsb9VLGV8foJHaPMfoKK645XDiZ";
const SOLANA_SETTLER = new PublicKey(
  SOLANA_OUTPUT_SETTLER.slice(2)
    .match(/../g)!
    .map((byte) => parseInt(byte, 16))
).toBase58();

function outputFor(chainId: number): MandateOutput {
  const solana = chainId === SOLANA;
  return {
    chainId: BigInt(chainId),
    oracle: solana ? WORMHOLE_ORACLE[chainId]! : addressToBytes32(WORMHOLE_ORACLE[chainId]!),
    settler: solana ? SOLANA_OUTPUT_SETTLER : addressToBytes32(COIN_FILLER),
    token: `0x${"01".repeat(32)}`,
    amount: 1n,
    recipient: `0x${"02".repeat(32)}`,
    callbackData: "0x",
    context: "0x"
  };
}

function orderFor(
  inputChainIds: number[],
  outputs: MandateOutput[],
  inputOracle = WORMHOLE_ORACLE[inputChainIds[0]]!
): OrderContainer {
  const shared = {
    user: `0x${"03".repeat(20)}` as Hex,
    nonce: 0n,
    expires: 1_800_010_000,
    fillDeadline: 1_800_000_000,
    inputOracle,
    outputs
  };
  return {
    inputSettler: `0x${"04".repeat(20)}`,
    order:
      inputChainIds.length === 1
        ? { ...shared, originChainId: BigInt(inputChainIds[0]!), inputs: [[1n, 1n]] }
        : {
            ...shared,
            inputs: inputChainIds.map((chainId) => ({
              chainId: BigInt(chainId),
              inputs: [[1n, 1n] as [bigint, bigint]]
            }))
          },
    sponsorSignature: { type: "None", payload: "0x" },
    allocatorSignature: { type: "None", payload: "0x" }
  };
}

type EvmRouteFixture = {
  actualChainId: number;
  core: Hex;
  nativeId: number;
  code: Hex;
  missingCodeAt: string;
  rpcError: boolean;
  oldAbi: boolean;
  forward: Map<number, bigint>;
  reverse: Map<string, bigint>;
  chainReads: number;
  codeReads: number;
  contractReads: number;
  mappingReads: string[];
};
type SolanaRouteFixture = {
  state: { genesis: string; accountReads: number; genesisReads: number; rpcError: boolean };
  accounts: Map<string, SolanaAccountInfoLike>;
  reads: SolanaConnectionLike;
};

function evmFixture(chainId: number) {
  const state: EvmRouteFixture = {
    actualChainId: chainId,
    core: WORMHOLE_CORE[chainId]!,
    nativeId: WORMHOLE_CHAIN_IDS[chainId]!,
    code: "0x6000" as Hex,
    missingCodeAt: "",
    rpcError: false,
    oldAbi: false,
    forward: new Map<number, bigint>(),
    reverse: new Map<string, bigint>(),
    chainReads: 0,
    codeReads: 0,
    contractReads: 0,
    mappingReads: [] as string[]
  };
  for (const [canonicalId, nativeId] of Object.entries(WORMHOLE_CHAIN_IDS)) {
    state.forward.set(nativeId!, BigInt(canonicalId));
    state.reverse.set(canonicalId, BigInt(nativeId!));
  }
  const client = createPublicClient({
    transport: custom(
      {
        request: async ({ method, params }) => {
          if (state.rpcError) throw new Error("RPC temporarily unavailable");
          if (method === "eth_chainId") {
            state.chainReads++;
            return `0x${state.actualChainId.toString(16)}`;
          }
          if (method === "eth_getCode") {
            state.codeReads++;
            const [address] = params as [string];
            return address.toLowerCase() === state.missingCodeAt.toLowerCase() ? "0x" : state.code;
          }
          if (method === "eth_call") {
            state.contractReads++;
            const [{ to, data }] = params as [{ to: string; data: Hex }];
            if (to.toLowerCase() === WORMHOLE_CORE[chainId]!.toLowerCase()) {
              return encodeFunctionResult({
                abi: WORMHOLE_CORE_ABI,
                functionName: "chainId",
                result: state.nativeId
              });
            }
            if (state.oldAbi) return "0x";
            const decoded = decodeFunctionData({ abi: WORMHOLE_ORACLE_ABI, data });
            switch (decoded.functionName) {
              case "WORMHOLE":
                return encodeFunctionResult({
                  abi: WORMHOLE_ORACLE_ABI,
                  functionName: "WORMHOLE",
                  result: state.core
                });
              case "chainIdMap": {
                const id = decoded.args[0];
                state.mappingReads.push(`forward:${id}`);
                return encodeFunctionResult({
                  abi: WORMHOLE_ORACLE_ABI,
                  functionName: "chainIdMap",
                  result: state.forward.get(Number(id)) ?? 0n
                });
              }
              case "reverseChainIdMap": {
                const id = decoded.args[0];
                state.mappingReads.push(`reverse:${id}`);
                return encodeFunctionResult({
                  abi: WORMHOLE_ORACLE_ABI,
                  functionName: "reverseChainIdMap",
                  result: state.reverse.get(id.toString()) ?? 0n
                });
              }
              default:
                throw new Error(`Unexpected route read: ${decoded.functionName}`);
            }
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        }
      },
      { retryCount: 0 }
    )
  });
  clientsById[chainId] = {
    ...clientsById[chainId],
    getChainId: client.getChainId,
    getBytecode: client.getBytecode,
    readContract: client.readContract
  };
  return state;
}

function mappingData(canonicalId: bigint): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(25);
  data.set(CHAIN_MAPPING_DISCRIMINATOR);
  for (let index = 0; index < 16; index++)
    data[8 + index] = Number((canonicalId >> BigInt(index * 8)) & 0xffn);
  return data;
}

function solanaFixture(): SolanaRouteFixture {
  const accounts = new Map<string, SolanaAccountInfoLike>();
  for (const program of [SOLANA_PROGRAM, SOLANA_CORE, OUTPUT_SETTLER_SIMPLE_PROGRAM_ID]) {
    accounts.set(program, {
      owner: "BPFLoaderUpgradeab1e11111111111111111111111",
      executable: true,
      lamports: 1,
      data: new Uint8Array()
    });
  }
  const data = new Uint8Array(89);
  data.set([0xda, 0xcf, 0xee, 0xbe, 0x62, 0xa3, 0x03, 0xc7]);
  data.set(new PublicKey(SOLANA_CORE).toBytes(), 40);
  for (let index = 0; index < 16; index++)
    data[72 + index] = Number((BigInt(SOLANA) >> BigInt(index * 8)) & 0xffn);
  data[88] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("wormhole")],
    new PublicKey(SOLANA_PROGRAM)
  )[1];
  accounts.set(SOLANA_STATE, { owner: SOLANA_PROGRAM, lamports: 1, data });
  accounts.set(SOLANA_SETTLER, {
    owner: OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
    lamports: 1,
    data: new Uint8Array()
  });
  for (const [canonicalId, nativeId] of Object.entries(WORMHOLE_CHAIN_IDS)) {
    accounts.set(chainMappingPda(new PublicKey(SOLANA_STATE), BigInt(nativeId!)).toBase58(), {
      owner: INTENTS_PROTOCOL_PROGRAM_ID,
      lamports: 1,
      data: mappingData(BigInt(canonicalId))
    });
  }
  const state = {
    genesis: solanaClient.SOLANA_GENESIS_HASHES[SOLANA.toString()]!,
    accountReads: 0,
    genesisReads: 0,
    rpcError: false
  };
  const reads = {
    getGenesisHash: async () => {
      state.genesisReads++;
      if (state.rpcError) throw new Error("Solana RPC temporarily unavailable");
      return state.genesis;
    },
    getAccountInfo: async (address: string) => {
      state.accountReads++;
      if (state.rpcError) throw new Error("Solana RPC temporarily unavailable");
      return accounts.get(address) ?? null;
    }
  } as SolanaConnectionLike;
  return { state, accounts, reads };
}

const originalClients = { ...clientsById };
let base: EvmRouteFixture;
let arbitrum: EvmRouteFixture;
let solana: SolanaRouteFixture;
let solanaReadsSpy: { mockRestore(): void };
beforeEach(() => {
  base = evmFixture(BASE);
  arbitrum = evmFixture(ARBITRUM);
  solana = solanaFixture();
  solanaReadsSpy = spyOn(solanaClient, "getSolanaReads").mockImplementation(
    async () => solana.reads
  );
});
afterEach(() => {
  solanaReadsSpy.mockRestore();
  for (const id of Object.keys(clientsById)) clientsById[Number(id)] = originalClients[Number(id)]!;
});

describe("recorded oracle provider", () => {
  test("recognizes Wormhole addresses, clean padded addresses, and Solana state PDA", () => {
    expect(oracleProviderFor(BASE, WORMHOLE_ORACLE[BASE]!)).toBe("wormhole");
    expect(oracleProviderFor(BASE, addressToBytes32(WORMHOLE_ORACLE[BASE]!))).toBe("wormhole");
    expect(oracleProviderFor(SOLANA, WORMHOLE_ORACLE[SOLANA]!)).toBe("wormhole");
    expect(oracleProviderFor(ARBITRUM, WORMHOLE_ORACLE[BASE]!)).toBeUndefined();
    expect(
      oracleProviderFor(BASE, `0x01${addressToBytes32(WORMHOLE_ORACLE[BASE]!).slice(4)}`)
    ).toBeUndefined();
  });

  test("retains Polymer current and known legacy identities", () => {
    expect(oracleProviderFor(BASE, POLYMER_ORACLE[BASE]!)).toBe("polymer");
    for (const [chainId, oracles] of Object.entries(TRON_LEGACY_POLYMER_ORACLES)) {
      for (const oracle of oracles ?? [])
        expect(oracleProviderFor(BigInt(chainId), oracle)).toBe("polymer");
    }
  });
});

describe("Wormhole route readiness", () => {
  test("same-chain bypass needs no deployment or RPC", async () => {
    base.rpcError = true;
    expect(
      await checkWormholeRoute(BigInt(BASE), "0x", {
        ...outputFor(BASE),
        oracle: "0x",
        settler: "0x"
      })
    ).toEqual({ ready: true });
    expect(base.chainReads).toBe(0);
  });

  test("distinct Base and Arbitrum oracle deployments work in both directions", async () => {
    expect(
      await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))
    ).toEqual({ ready: true });
    expect(
      await checkWormholeRoute(BigInt(ARBITRUM), WORMHOLE_ORACLE[ARBITRUM]!, outputFor(BASE))
    ).toEqual({ ready: true });
    expect(base.mappingReads).toEqual(["forward:23", "reverse:42161"]);
    expect(arbitrum.mappingReads).toEqual(["forward:30", "reverse:8453"]);
  });

  test("unsupported, devnet and mixed-network routes refuse before RPC", async () => {
    const unsupported = await checkWormholeRoute(
      728126428n,
      WORMHOLE_ORACLE[BASE]!,
      outputFor(ARBITRUM)
    );
    expect(unsupported).toMatchObject({
      ready: false,
      reason: expect.stringContaining("no supported deployment")
    });
    const devnet = await checkWormholeRoute(
      SOLANA_DEVNET_CHAIN_ID,
      WORMHOLE_ORACLE[SOLANA]!,
      outputFor(BASE)
    );
    expect(devnet.ready).toBe(false);
    const mixed = await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(84532));
    expect(mixed).toMatchObject({ ready: false, reason: expect.stringContaining("same network") });
    expect(base.chainReads + arbitrum.chainReads + solana.state.genesisReads).toBe(0);
  });

  test("rejects provider mixing, input oracle mismatch, program/PDA confusion and dirty output identities", async () => {
    for (const oracle of [POLYMER_ORACLE[BASE]!, WORMHOLE_ORACLE[ARBITRUM]!]) {
      expect((await checkWormholeRoute(BigInt(BASE), oracle, outputFor(ARBITRUM))).ready).toBe(
        false
      );
    }
    const remote = outputFor(ARBITRUM);
    for (const changed of [
      { ...remote, oracle: addressToBytes32(POLYMER_ORACLE[ARBITRUM]!) },
      { ...remote, oracle: `0x01${remote.oracle.slice(4)}` as Hex },
      { ...remote, settler: `0x01${remote.settler.slice(4)}` as Hex },
      {
        ...outputFor(SOLANA),
        oracle: `0x${Buffer.from(new PublicKey(SOLANA_PROGRAM).toBytes()).toString("hex")}` as Hex
      }
    ]) {
      expect((await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, changed)).ready).toBe(
        false
      );
    }
    expect(base.chainReads + arbitrum.chainReads).toBe(0);
  });

  test("requires code at the oracle, Core, and settler", async () => {
    for (const address of [WORMHOLE_ORACLE[BASE]!, WORMHOLE_CORE[BASE]!, COIN_FILLER]) {
      base.missingCodeAt = address;
      expect(
        await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))
      ).toMatchObject({ ready: false, reason: expect.stringContaining("no executable code") });
    }
    base.missingCodeAt = "";
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))).ready
    ).toBe(true);
  });

  test("requires actual RPC identity, exact Core, native chain ID, and compatible ABI", async () => {
    base.actualChainId = 1;
    expect(
      await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))
    ).toMatchObject({ ready: false, reason: expect.stringContaining("different chain") });
    base.actualChainId = BASE;
    base.core = WORMHOLE_CORE[ARBITRUM]!;
    expect(
      await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))
    ).toMatchObject({ ready: false, reason: expect.stringContaining("Core mismatch") });
    base.core = WORMHOLE_CORE[BASE]!;
    base.nativeId = 23;
    expect(
      await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))
    ).toMatchObject({ ready: false, reason: expect.stringContaining("native chain ID") });
    base.nativeId = 30;
    base.oldAbi = true;
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))).ready
    ).toBe(false);
    base.oldAbi = false;
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))).ready
    ).toBe(true);
  });

  test("nonzero but incorrect forward or reverse mappings never authorize a route", async () => {
    base.forward.set(23, 1n);
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))).ready
    ).toBe(false);
    base.forward.set(23, BigInt(ARBITRUM));
    base.reverse.set(ARBITRUM.toString(), 2n);
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))).ready
    ).toBe(false);
    base.reverse.set(ARBITRUM.toString(), 23n);
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))).ready
    ).toBe(true);
  });

  test("caches only immutable success and still rechecks actual RPC identity", async () => {
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))).ready
    ).toBe(true);
    const immutableReads =
      base.codeReads + base.contractReads + arbitrum.codeReads + arbitrum.contractReads;
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))).ready
    ).toBe(true);
    expect(base.codeReads + base.contractReads + arbitrum.codeReads + arbitrum.contractReads).toBe(
      immutableReads
    );
    expect(base.chainReads).toBe(2);
    base.actualChainId = 1;
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))).ready
    ).toBe(false);
    base.actualChainId = BASE;
    base = evmFixture(BASE);
    base.oldAbi = true;
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))).ready
    ).toBe(false);
  });

  test("RPC failures remain retryable without poisoning the success cache", async () => {
    base.rpcError = true;
    expect(
      await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))
    ).toMatchObject({ ready: false, reason: expect.stringContaining("retry") });
    base.rpcError = false;
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(ARBITRUM))).ready
    ).toBe(true);
  });
});

describe("Solana route readiness", () => {
  test("Base ↔ Solana uses state PDA and native output mapping", async () => {
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(SOLANA))).ready
    ).toBe(true);
    expect(base.mappingReads).toEqual(["forward:1", `reverse:${SOLANA}`]);
    expect(
      (await checkWormholeRoute(BigInt(SOLANA), WORMHOLE_ORACLE[SOLANA]!, outputFor(BASE))).ready
    ).toBe(true);
  });

  test("cached success cannot bypass a changed Solana genesis identity", async () => {
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(SOLANA))).ready
    ).toBe(true);
    const accountReads = solana.state.accountReads;
    expect(
      (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(SOLANA))).ready
    ).toBe(true);
    expect(solana.state.accountReads).toBe(accountReads);
    expect(solana.state.genesisReads).toBe(2);
    solana.state.genesis = solanaClient.SOLANA_GENESIS_HASHES[SOLANA_DEVNET_CHAIN_ID.toString()]!;
    expect(
      await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(SOLANA))
    ).toMatchObject({ ready: false, reason: expect.stringContaining("different cluster") });
  });

  test.each([SOLANA_PROGRAM, SOLANA_CORE, OUTPUT_SETTLER_SIMPLE_PROGRAM_ID])(
    "requires executable program %s",
    async (program) => {
      solana.accounts.set(program, { ...solana.accounts.get(program)!, executable: false });
      expect(
        (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(SOLANA))).ready
      ).toBe(false);
      solana.accounts.set(program, { ...solana.accounts.get(program)!, executable: true });
      expect(
        (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(SOLANA))).ready
      ).toBe(true);
    }
  );

  test.each(["owner", "discriminator", "length", "Core", "chainId", "bump"])(
    "rejects wrong oracle state %s",
    async (fault) => {
      const original = solana.accounts.get(SOLANA_STATE)!;
      const changed = { ...original, data: new Uint8Array(original.data) };
      if (fault === "owner") changed.owner = OUTPUT_SETTLER_SIMPLE_PROGRAM_ID;
      if (fault === "discriminator") changed.data[0] ^= 1;
      if (fault === "length") changed.data = changed.data.subarray(0, 88);
      if (fault === "Core") changed.data[40] ^= 1;
      if (fault === "chainId") changed.data[72] ^= 1;
      if (fault === "bump") changed.data[88] ^= 1;
      solana.accounts.set(SOLANA_STATE, changed);
      expect(
        (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(SOLANA))).ready
      ).toBe(false);
      solana.accounts.set(SOLANA_STATE, original);
      expect(
        (await checkWormholeRoute(BigInt(BASE), WORMHOLE_ORACLE[BASE]!, outputFor(SOLANA))).ready
      ).toBe(true);
    }
  );

  test.each(["absent", "owner", "discriminator", "short", "long", "canonicalId"])(
    "rejects wrong protocol mapping %s",
    async (fault) => {
      const address = chainMappingPda(new PublicKey(SOLANA_STATE), 30n).toBase58();
      const original = solana.accounts.get(address)!;
      const changed = { ...original, data: new Uint8Array(original.data) };
      if (fault === "owner") changed.owner = SOLANA_PROGRAM;
      if (fault === "discriminator") changed.data[0] ^= 1;
      if (fault === "short") changed.data = changed.data.subarray(0, 24);
      if (fault === "long") changed.data = new Uint8Array(26);
      if (fault === "canonicalId") changed.data = mappingData(1n);
      solana.accounts.set(address, fault === "absent" ? null : changed);
      expect(
        (await checkWormholeRoute(BigInt(SOLANA), WORMHOLE_ORACLE[SOLANA]!, outputFor(BASE))).ready
      ).toBe(false);
      solana.accounts.set(address, original);
      expect(
        (await checkWormholeRoute(BigInt(SOLANA), WORMHOLE_ORACLE[SOLANA]!, outputFor(BASE))).ready
      ).toBe(true);
    }
  );

  test("a Polymer mapping at the same native ID cannot substitute for the Wormhole mapping", async () => {
    solana.accounts.delete(chainMappingPda(new PublicKey(SOLANA_STATE), 30n).toBase58());
    solana.accounts.set(chainMappingPda(polymerOraclePda(), 30n).toBase58(), {
      owner: INTENTS_PROTOCOL_PROGRAM_ID,
      lamports: 1,
      data: mappingData(BigInt(BASE))
    });
    expect(
      (await checkWormholeRoute(BigInt(SOLANA), WORMHOLE_ORACLE[SOLANA]!, outputFor(BASE))).ready
    ).toBe(false);
  });
});

describe("whole-order readiness", () => {
  test("rejects multichain inputs with different configured oracles before reads", async () => {
    await expect(
      assertWormholeOrderReady(orderFor([BASE, ARBITRUM], [outputFor(SOLANA)]))
    ).rejects.toThrow(
      "Wormhole multichain inputs require the same oracle address on every input chain."
    );
    expect(base.chainReads + arbitrum.chainReads + solana.state.genesisReads).toBe(0);
  });

  test("every input must map every remote output, not just the first pair", async () => {
    const ethereum = evmFixture(1);
    const bsc = evmFixture(56);
    bsc.forward.set(23, 1n);
    await expect(
      assertWormholeOrderReady(orderFor([1, 56], [outputFor(BASE), outputFor(ARBITRUM)]))
    ).rejects.toThrow("bidirectional chain mapping");
    expect(ethereum.mappingReads).toEqual([
      "forward:30",
      "reverse:8453",
      "forward:23",
      "reverse:42161"
    ]);
    expect(bsc.mappingReads).toEqual(["forward:30", "reverse:8453", "forward:23", "reverse:42161"]);
    bsc.forward.set(23, BigInt(ARBITRUM));
    await expect(
      assertWormholeOrderReady(orderFor([1, 56], [outputFor(BASE), outputFor(ARBITRUM)]))
    ).resolves.toBeUndefined();
  });

  test("Polymer and same-chain orders keep their existing path", async () => {
    base.rpcError = true;
    await expect(
      assertWormholeOrderReady(orderFor([BASE], [outputFor(ARBITRUM)], POLYMER_ORACLE[BASE]!))
    ).resolves.toBeUndefined();
    await expect(
      assertWormholeOrderReady(orderFor([BASE], [outputFor(BASE)]))
    ).resolves.toBeUndefined();
    expect(base.chainReads).toBe(0);
  });
});

describe("issuance Wormhole readiness", () => {
  test.each([
    [BASE, ARBITRUM],
    [BASE, SOLANA],
    [SOLANA, BASE]
  ])(
    "read-only selection and SDK-built order support %s → %s without a connected wallet",
    async (inputChain, outputChain) => {
      await expect(
        assertWormholeSelectionReady([inputChain], [outputChain], "wormhole")
      ).resolves.toBeUndefined();
      const account =
        inputChain === SOLANA ? (`0x${"03".repeat(32)}` as Hex) : (`0x${"03".repeat(20)}` as Hex);
      const recipient =
        outputChain === SOLANA ? (`0x${"04".repeat(32)}` as Hex) : (`0x${"04".repeat(20)}` as Hex);
      const tokenFor = (chainId: number) => ({
        token: {
          chainId: BigInt(chainId),
          chainNamespace: namespaceForChain(chainId),
          address:
            chainId === SOLANA ? (`0x${"01".repeat(32)}` as Hex) : (`0x${"01".repeat(20)}` as Hex),
          name: "USDC",
          decimals: 6
        },
        amount: 1_000_000n
      });
      const intent = new Intent(
        {
          account,
          outputRecipient: recipient,
          inputTokens: [tokenFor(inputChain)],
          outputTokens: [tokenFor(outputChain)],
          verifier: "wormhole",
          lock: { type: "escrow" }
        },
        intentDeps
      ).order();
      const container: OrderContainer = {
        order: intent.asOrder(),
        inputSettler: intent.inputSettler,
        sponsorSignature: { type: "None", payload: "0x" },
        allocatorSignature: { type: "None", payload: "0x" }
      };
      expect(container.order.inputOracle).toBe(WORMHOLE_ORACLE[inputChain]!);
      expect(container.order.outputs[0]!.oracle).toBe(outputFor(outputChain).oracle);
      await expect(assertWormholeOrderReady(container)).resolves.toBeUndefined();
    }
  );

  test("unsupported selections fail with the same route reason before wallet access", async () => {
    const result = await checkWormholeRoute(728126428n, "0x", outputFor(BASE));
    if (result.ready) throw new Error("Unsupported route was accepted");
    await expect(assertWormholeSelectionReady([728126428], [BASE], "wormhole")).rejects.toThrow(
      result.reason
    );
    await expect(
      assertWormholeSelectionReady([BASE], [Number(SOLANA_DEVNET_CHAIN_ID)], "wormhole")
    ).rejects.toThrow("no supported deployment");
    expect(base.chainReads + arbitrum.chainReads + solana.state.genesisReads).toBe(0);
  });

  test("selection checks every input and output with one global oracle", async () => {
    await expect(
      assertWormholeSelectionReady([BASE, ARBITRUM], [SOLANA], "wormhole")
    ).rejects.toThrow(
      "Wormhole multichain inputs require the same oracle address on every input chain."
    );
    const ethereum = evmFixture(1);
    const bsc = evmFixture(56);
    bsc.reverse.set(ARBITRUM.toString(), 2n);
    await expect(
      assertWormholeSelectionReady([1, 56], [BASE, ARBITRUM], "wormhole")
    ).rejects.toThrow("bidirectional chain mapping");
    expect(ethereum.mappingReads).toEqual([
      "forward:30",
      "reverse:8453",
      "forward:23",
      "reverse:42161"
    ]);
    expect(bsc.mappingReads).toEqual(["forward:30", "reverse:8453", "forward:23", "reverse:42161"]);
  });

  test("action-time readiness rechecks RPC identity after earlier availability", async () => {
    await assertWormholeSelectionReady([BASE], [ARBITRUM], "wormhole");
    base.actualChainId = 1;
    await expect(assertWormholeSelectionReady([BASE], [ARBITRUM], "wormhole")).rejects.toThrow(
      "different chain"
    );
  });

  test("same-chain and Polymer selections need neither Wormhole deployments nor reads", async () => {
    base.rpcError = true;
    await expect(
      assertWormholeSelectionReady([728126428], [728126428], "wormhole")
    ).resolves.toBeUndefined();
    await expect(
      assertWormholeSelectionReady([BASE], [ARBITRUM], "polymer")
    ).resolves.toBeUndefined();
    expect(base.chainReads).toBe(0);
  });
});
