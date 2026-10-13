import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { base58, base64 } from "@scure/base";
import {
  addressToBytes32,
  bytes32ToAddress,
  encodeFillDescription,
  encodeNotFilledDescription,
  SOLANA_MAINNET_CHAIN_ID
} from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import { createVAA, serialize, UniversalAddress } from "@wormhole-foundation/sdk-definitions";
import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, toEventSelector } from "viem";
import type { Hex, Log, TransactionReceipt } from "viem";
import {
  clientsById,
  COIN_FILLER,
  SOLANA_OUTPUT_SETTLER,
  WORMHOLE_CORE,
  WORMHOLE_ORACLE
} from "../../src/lib/config";
import type { WC } from "../../src/lib/config";
import { WORMHOLE_CORE_ABI } from "../../src/lib/abi/wormholecore";
import {
  clearWormholeHint,
  findWormholePublication,
  loadWormholeHint,
  publishEvmWormhole,
  saveWormholeHint,
  saveWormholeMessageAccount,
  verifyWormholePublication
} from "../../src/lib/libraries/wormholePublication";
import type {
  WormholeExpectedMessage,
  WormholePublication
} from "../../src/lib/libraries/wormholeProof";
import { b32, makeMandateOutput, TEST_NOW_SECONDS } from "../fixtures/orderFixtures";

const CHAIN = 8453;
const ACCOUNT = `0x${"ab".repeat(20)}` as Hex;
const OTHER_ACCOUNT = `0x${"cd".repeat(20)}` as Hex;
const output = makeMandateOutput(BigInt(CHAIN), 123n, {
  oracle: addressToBytes32(WORMHOLE_ORACLE[CHAIN]!),
  settler: addressToBytes32(COIN_FILLER)
});
const payload = encodeFillDescription({
  orderId: b32("a"),
  output,
  solver: addressToBytes32(ACCOUNT),
  timestamp: TEST_NOW_SECONDS
});
const expected: WormholeExpectedMessage = { application: output.settler, payload };
const SEQUENCE = 9007199254740993n;
function tx(value: number): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function envelope(payloads: Hex[], application = output.settler): Uint8Array {
  const parts = payloads.map((payload) => hexToBytes(payload));
  const bytes = new Uint8Array(34 + parts.reduce((sum, part) => sum + 2 + part.length, 0));
  bytes.set(hexToBytes(application));
  const view = new DataView(bytes.buffer);
  view.setUint16(32, parts.length);
  let offset = 34;
  for (const part of parts) {
    view.setUint16(offset, part.length);
    offset += 2;
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

type EventOptions = {
  hash?: Hex;
  block?: bigint;
  sequence?: bigint;
  sender?: Hex;
  address?: Hex;
  nonce?: number;
  consistency?: number;
  body?: Hex;
  index?: number;
};
function messageLog(options: EventOptions = {}): Log<bigint, number, false> {
  return {
    address: options.address ?? WORMHOLE_CORE[CHAIN]!,
    topics: [
      toEventSelector(WORMHOLE_CORE_ABI[2]),
      addressToBytes32(options.sender ?? WORMHOLE_ORACLE[CHAIN]!)
    ],
    data: encodeAbiParameters(
      [{ type: "uint64" }, { type: "uint32" }, { type: "bytes" }, { type: "uint8" }],
      [
        options.sequence ?? SEQUENCE,
        options.nonce ?? 0,
        options.body ?? bytesToHex(envelope([payload])),
        options.consistency ?? 15
      ]
    ),
    blockHash: tx(100),
    blockNumber: options.block ?? 50_000n,
    transactionHash: options.hash ?? tx(1),
    transactionIndex: 0,
    logIndex: options.index ?? 0,
    removed: false
  };
}
function receipt(
  logs: Log<bigint, number, false>[],
  hash = tx(1),
  success = true
): TransactionReceipt {
  return {
    transactionHash: hash,
    blockNumber: logs[0]?.blockNumber ?? 50_000n,
    status: success ? "success" : "reverted",
    logs
  } as TransactionReceipt;
}
function publication(sequence = SEQUENCE, hash: string | undefined = tx(1)): WormholePublication {
  return {
    id: {
      network: "mainnet",
      emitterChain: 30,
      emitter: output.oracle,
      sequence: sequence.toString()
    },
    nonce: 0,
    consistencyLevel: 15,
    ...(hash ? { txRef: hash } : {})
  };
}
function signedVaa(sequence: bigint, body = envelope([payload])): string {
  return base64.encode(
    serialize(
      createVAA("Uint8Array", {
        guardianSet: 0,
        signatures: [],
        timestamp: TEST_NOW_SECONDS,
        nonce: 0,
        emitterChain: "Base",
        emitterAddress: new UniversalAddress(hexToBytes(output.oracle)),
        sequence,
        consistencyLevel: 15,
        payload: body
      })
    )
  );
}

type Simulation = {
  address: Hex;
  args: readonly [Hex, readonly Hex[]];
  account: Hex;
  value: bigint;
};
type LogQuery = { address: Hex; args: { sender: Hex }; fromBlock: bigint; toBlock: bigint };
type Fixture = {
  wallet: WC;
  state: {
    walletChain: number;
    rpcChain: number;
    addresses: Hex[];
    switchWorks: boolean;
    fee: bigint;
    core: Hex;
    nativeId: number;
    latest: bigint;
    receipt: TransactionReceipt;
    events: Log<bigint, number, false>[];
    receipts: Map<Hex, TransactionReceipt>;
    actions: string[];
    simulations: Simulation[];
    writes: Simulation[];
    queries: LogQuery[];
    receiptsRead: Hex[];
    maxRange?: bigint;
    failHistory: boolean;
    duringSimulation?: () => void;
  };
};
function makeFixture(): Fixture {
  const event = messageLog();
  const state: Fixture["state"] = {
    walletChain: CHAIN,
    rpcChain: CHAIN,
    addresses: [ACCOUNT],
    switchWorks: true,
    fee: 7n,
    core: WORMHOLE_CORE[CHAIN]!,
    nativeId: 30,
    latest: 50_000n,
    receipt: receipt([event]),
    events: [event],
    receipts: new Map([[tx(1), receipt([event])]]),
    actions: [],
    simulations: [],
    writes: [],
    queries: [],
    receiptsRead: [],
    failHistory: false
  };
  const client = {
    getChainId: async () => state.rpcChain,
    readContract: async ({ functionName }: { functionName: string }) => {
      state.actions.push(functionName);
      if (functionName === "WORMHOLE") return state.core;
      if (functionName === "chainId") return state.nativeId;
      if (functionName === "messageFee") return state.fee;
      throw new Error(`Unexpected contract call ${functionName}`);
    },
    simulateContract: async (request: Simulation) => {
      state.actions.push("simulate");
      state.simulations.push(request);
      state.duringSimulation?.();
      return { request, result: 123456n }; // Refund value must never become a sequence.
    },
    waitForTransactionReceipt: async () => {
      state.actions.push("receipt");
      return state.receipt;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      state.receiptsRead.push(hash);
      const found = state.receipts.get(hash);
      if (!found) throw new Error("Archival receipt unavailable");
      return found;
    },
    getBlockNumber: async () => state.latest,
    getLogs: async (query: LogQuery) => {
      state.queries.push(query);
      if (
        state.failHistory ||
        (state.maxRange && query.toBlock - query.fromBlock + 1n > state.maxRange)
      )
        throw new Error("RPC log range unavailable");
      return state.events.filter(
        (log) => log.blockNumber >= query.fromBlock && log.blockNumber <= query.toBlock
      );
    }
  };
  clientsById[CHAIN] = client as unknown as (typeof clientsById)[number];
  const wallet = {
    getChainId: async () => state.walletChain,
    getAddresses: async () => state.addresses,
    switchChain: async ({ id }: { id: number }) => {
      state.actions.push("switch");
      if (state.switchWorks) state.walletChain = id;
    },
    writeContract: async (request: Simulation) => {
      state.actions.push("write");
      state.writes.push(request);
      return tx(1);
    }
  } as unknown as WC;
  return { state, wallet };
}

const originalClient = clientsById[CHAIN];
const originalFetch = globalThis.fetch;
function fetchFixture(
  handler: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => Promise<Response>
): typeof fetch {
  return Object.assign(handler, { preconnect: originalFetch.preconnect });
}
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let storage: Map<string, string>;
let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
  storage = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      }
    }
  });
  globalThis.fetch = fetchFixture(async () => new Response("", { status: 404 }));
});
afterEach(() => {
  clientsById[CHAIN] = originalClient;
  globalThis.fetch = originalFetch;
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("EVM Wormhole publication", () => {
  test("switches output wallet, reads current fee, guards after simulation and records actual uint64 sequence", async () => {
    fixture.state.walletChain = 1;
    const result = await publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT, {
      beforeSpend: async () => {
        fixture.state.actions.push("guard");
      }
    });
    expect(fixture.state.actions).toEqual([
      "switch",
      "WORMHOLE",
      "chainId",
      "messageFee",
      "simulate",
      "guard",
      "write",
      "receipt"
    ]);
    expect(fixture.state.simulations[0]).toMatchObject({
      address: WORMHOLE_ORACLE[CHAIN],
      account: ACCOUNT,
      value: 7n,
      args: [bytes32ToAddress(output.settler), [payload]]
    });
    expect(result).toEqual(publication());
    expect(loadWormholeHint(output, expected)).toEqual(result);
  });
  test("uses the existing transport-provider switch fallback without loading SvelteKit", async () => {
    fixture.state.walletChain = 1;
    Reflect.deleteProperty(fixture.wallet, "switchChain");
    Object.assign(fixture.wallet, {
      transport: {
        value: {
          request: async ({ method }: { method: string }) => {
            expect(method).toBe("wallet_switchEthereumChain");
            fixture.state.walletChain = CHAIN;
          }
        }
      }
    });
    expect(await publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT)).toEqual(
      publication()
    );
    expect(fixture.state.writes).toHaveLength(1);
  });
  test("non-fill publication submits the SDK tagged deadline directly, without an emitNotFilled transaction", async () => {
    const nonFill = encodeNotFilledDescription({
      orderId: b32("a"),
      output,
      fillDeadline: TEST_NOW_SECONDS
    });
    fixture.state.receipt = receipt([messageLog({ body: bytesToHex(envelope([nonFill])) })]);
    expect(await publishEvmWormhole(output, nonFill, fixture.wallet, ACCOUNT)).toEqual(
      publication()
    );
    expect(fixture.state.simulations[0]!.args).toEqual([
      bytes32ToAddress(output.settler),
      [nonFill]
    ]);
    expect(fixture.state.writes).toHaveLength(1);
  });
  test("re-reads mutable fee for each publication", async () => {
    await publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT);
    fixture.state.fee = 19n;
    await publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT);
    expect(fixture.state.writes.map((write) => write.value)).toEqual([7n, 19n]);
  });
  test("rejects a switch that leaves the wallet on another chain without simulation or spend", async () => {
    fixture.state.walletChain = 1;
    fixture.state.switchWorks = false;
    await expect(publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT)).rejects.toThrow(
      "Switch your wallet"
    );
    expect(fixture.state.simulations).toHaveLength(0);
    expect(fixture.state.writes).toHaveLength(0);
  });
  test("rejects disconnected or stale output wallet accounts", async () => {
    await expect(
      publishEvmWormhole(output, payload, fixture.wallet, OTHER_ACCOUNT)
    ).rejects.toThrow("not connected");
    fixture.state.duringSimulation = () => {
      fixture.state.addresses = [OTHER_ACCOUNT];
    };
    await expect(publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT)).rejects.toThrow(
      "not connected"
    );
    expect(fixture.state.writes).toHaveLength(0);
  });
  test("rejects a wallet-chain change during simulation", async () => {
    fixture.state.duringSimulation = () => {
      fixture.state.walletChain = 1;
    };
    await expect(publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT)).rejects.toThrow(
      "Switch your wallet"
    );
    expect(fixture.state.writes).toHaveLength(0);
  });
  test("fresh beforeSpend veto prevents the transaction", async () => {
    await expect(
      publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT, {
        beforeSpend: async () => {
          throw new Error("Order was delivered");
        }
      })
    ).rejects.toThrow("Order was delivered");
    expect(fixture.state.simulations).toHaveLength(1);
    expect(fixture.state.writes).toHaveLength(0);
  });
  test("wrong RPC or configured Core prevents spend", async () => {
    fixture.state.rpcChain = 1;
    await expect(publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT)).rejects.toThrow(
      "different output chain"
    );
    fixture.state.rpcChain = CHAIN;
    fixture.state.core = OTHER_ACCOUNT;
    await expect(publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT)).rejects.toThrow(
      "identity mismatch"
    );
    expect(fixture.state.writes).toHaveLength(0);
  });
  test("wrong source oracle, dirty EVM application and untagged payload reject before spend", async () => {
    for (const [changed, data] of [
      [{ ...output, oracle: addressToBytes32(OTHER_ACCOUNT) }, payload],
      [{ ...output, settler: b32("f") }, payload],
      [output, "0x12345678"]
    ] as [MandateOutput, Hex][]) {
      await expect(publishEvmWormhole(changed, data, fixture.wallet, ACCOUNT)).rejects.toThrow();
    }
    expect(fixture.state.simulations).toHaveLength(0);
    expect(fixture.state.writes).toHaveLength(0);
  });
  test.each([
    ["wrong Core", { address: OTHER_ACCOUNT }],
    ["wrong sender", { sender: OTHER_ACCOUNT }],
    ["wrong nonce", { nonce: 1 }],
    ["wrong consistency", { consistency: 1 }],
    ["truncated envelope", { body: "0x1234" }],
    ["other application", { body: bytesToHex(envelope([payload], b32("d"))) }],
    [
      "altered payload",
      {
        body: bytesToHex(
          envelope([
            encodeFillDescription({
              orderId: b32("a"),
              output,
              solver: addressToBytes32(ACCOUNT),
              timestamp: TEST_NOW_SECONDS + 1
            })
          ])
        )
      }
    ]
  ] as [string, EventOptions][])(
    "rejects receipt containing %s instead of the intended publication",
    async (_label, changes) => {
      fixture.state.receipt = receipt([messageLog(changes)]);
      await expect(publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT)).rejects.toThrow(
        "no matching Core"
      );
      expect(storage.size).toBe(0);
    }
  );
  test("ignores unrelated receipt events, but rejects two exact matches", async () => {
    fixture.state.receipt = receipt([messageLog({ sender: OTHER_ACCOUNT }), messageLog()]);
    expect(await publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT)).toEqual(
      publication()
    );
    fixture.state.receipt = receipt([
      messageLog(),
      messageLog({ sequence: SEQUENCE + 1n, index: 1 })
    ]);
    await expect(publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT)).rejects.toThrow(
      "Ambiguous"
    );
  });
  test("a reverted receipt never returns a publication", async () => {
    fixture.state.receipt = receipt([messageLog()], tx(1), false);
    await expect(publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT)).rejects.toThrow(
      "reverted"
    );
    expect(loadWormholeHint(output, expected)).toBeUndefined();
  });
});

describe("untrusted publication hints", () => {
  test("uses full source/application/payload hash key and strips non-locator fields", () => {
    saveWormholeHint(output, expected, {
      ...publication(),
      secretKey: "do not store",
      proof: "0x1234"
    } as WormholePublication);
    const key = `lintent.wormhole.v1.${CHAIN}.${output.oracle.toLowerCase()}.${output.settler.toLowerCase()}.${keccak256(payload)}`;
    expect([...storage.keys()]).toEqual([key]);
    expect(JSON.parse(storage.get(key)!)).toEqual(publication());
    const second = encodeNotFilledDescription({
      orderId: b32("a"),
      output,
      fillDeadline: TEST_NOW_SECONDS
    });
    expect(loadWormholeHint(output, { ...expected, payload: second })).toBeUndefined();
    clearWormholeHint(output, { ...expected, payload: second });
    expect(storage.size).toBe(1);
    clearWormholeHint(output, expected);
    expect(storage.size).toBe(0);
  });
  test("a pre-send Solana locator stores only its public address, never a predicted message identity", () => {
    const solanaOutput = makeMandateOutput(SOLANA_MAINNET_CHAIN_ID, 123n, {
      oracle: WORMHOLE_ORACLE[Number(SOLANA_MAINNET_CHAIN_ID)]!,
      settler: SOLANA_OUTPUT_SETTLER
    });
    const solanaExpected = {
      application: solanaOutput.settler,
      payload: encodeFillDescription({
        orderId: b32("a"),
        output: solanaOutput,
        solver: b32("b"),
        timestamp: TEST_NOW_SECONDS
      })
    };
    const messageAccount = base58.encode(new Uint8Array(32).fill(7));
    saveWormholeMessageAccount(solanaOutput, solanaExpected, messageAccount);
    expect([...storage.values()].map((value) => JSON.parse(value))).toEqual([{ messageAccount }]);
    expect(loadWormholeHint(solanaOutput, solanaExpected)).toBeUndefined();
    clearWormholeHint(solanaOutput, solanaExpected);
    saveWormholeMessageAccount(solanaOutput, solanaExpected, "invalid");
    saveWormholeMessageAccount(output, expected, messageAccount);
    expect(storage.size).toBe(0);
  });
  test("malformed or conflicting hints are ignored", () => {
    saveWormholeHint(output, expected, publication());
    const key = [...storage.keys()][0]!;
    for (const value of [
      "{",
      "null",
      JSON.stringify({ ...publication(), id: { ...publication().id, network: "testnet" } }),
      JSON.stringify({ ...publication(), txRef: "wrong" })
    ]) {
      storage.set(key, value);
      expect(loadWormholeHint(output, expected)).toBeUndefined();
    }
  });
  test("storage failure cannot break publication or hint clear", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("Storage denied");
      }
    });
    expect(await publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT)).toEqual(
      publication()
    );
    expect(loadWormholeHint(output, expected)).toBeUndefined();
    expect(() => clearWormholeHint(output, expected)).not.toThrow();
  });
  test("verification re-derives untrusted nonce and consistency from the receipt", async () => {
    expect(
      await verifyWormholePublication(output, expected, {
        ...publication(),
        nonce: 100,
        consistencyLevel: 3
      })
    ).toEqual(publication());
    expect(
      await verifyWormholePublication(output, expected, publication(SEQUENCE + 1n))
    ).toBeNull();
    expect(
      await verifyWormholePublication(output, expected, { ...publication(), txRef: undefined })
    ).toBeNull();
    expect(fixture.state.writes).toHaveLength(0);
  });
});

describe("publication recovery", () => {
  test("uses actual chain receipts, exact envelope and full decimal sequence", async () => {
    const found = await findWormholePublication(output, expected, publication());
    expect(found).toEqual(publication());
    expect(fixture.state.queries[0]).toMatchObject({
      address: WORMHOLE_CORE[CHAIN],
      args: { sender: WORMHOLE_ORACLE[CHAIN] }
    });
    expect(fixture.state.writes).toHaveLength(0);
  });
  test("id-only hints and Scan results cannot invent a source publication", async () => {
    fixture.state.events = [];
    let fetches = 0;
    globalThis.fetch = fetchFixture(async () => {
      fetches++;
      return Response.json({ vaaBytes: signedVaa(SEQUENCE) });
    });
    expect(
      await findWormholePublication(output, expected, { ...publication(), txRef: undefined })
    ).toBeNull();
    expect(fetches).toBe(0);
    expect(fixture.state.writes).toHaveLength(0);
  });
  test("a recovered batch publication may contain the exact selected payload alongside other payloads", async () => {
    const other = encodeNotFilledDescription({
      orderId: b32("a"),
      output,
      fillDeadline: TEST_NOW_SECONDS
    });
    const batch = messageLog({ body: bytesToHex(envelope([other, payload])) });
    fixture.state.events = [batch];
    fixture.state.receipts.set(tx(1), receipt([batch]));
    globalThis.fetch = fetchFixture(async () =>
      Response.json({ vaaBytes: signedVaa(SEQUENCE, envelope([other, payload])) })
    );
    expect(await findWormholePublication(output, expected)).toEqual(publication());
  });
  test("a forged hint is rediscovered rather than returned", async () => {
    const found = await findWormholePublication(output, expected, publication(SEQUENCE + 10n));
    expect(found).toEqual(publication());
    expect(loadWormholeHint(output, expected)).toEqual(publication());
  });
  test("newest signed beats a newer pending publication; newest pending is fallback", async () => {
    const newer = messageLog({ hash: tx(2), block: 50_001n, sequence: SEQUENCE + 1n });
    fixture.state.events.push(newer);
    fixture.state.latest = 50_001n;
    fixture.state.receipts.set(tx(2), receipt([newer], tx(2)));
    const requests: string[] = [];
    globalThis.fetch = fetchFixture(async (url) => {
      requests.push(String(url));
      return String(url).endsWith(`/${SEQUENCE}`)
        ? Response.json({ vaaBytes: signedVaa(SEQUENCE) })
        : new Response("", { status: 404 });
    });
    expect(await findWormholePublication(output, expected)).toEqual(publication());
    expect(requests[0]).toBe(
      `https://api.wormholescan.io/v1/signed_vaa/30/${output.oracle.slice(2)}/${SEQUENCE + 1n}`
    );
    globalThis.fetch = fetchFixture(async () => new Response("", { status: 404 }));
    expect(await findWormholePublication(output, expected)).toEqual(
      publication(SEQUENCE + 1n, tx(2))
    );
  });
  test("a mismatched signed VAA is a permanent candidate error, never silent republish", async () => {
    globalThis.fetch = fetchFixture(async () =>
      Response.json({ vaaBytes: signedVaa(SEQUENCE + 1n) })
    );
    await expect(findWormholePublication(output, expected)).rejects.toThrow("identity");
    expect(fixture.state.writes).toHaveLength(0);
  });
  test("transport error retains the same verified publication for retry", async () => {
    await publishEvmWormhole(output, payload, fixture.wallet, ACCOUNT);
    globalThis.fetch = fetchFixture(async () => new Response("", { status: 429 }));
    await expect(findWormholePublication(output, expected)).rejects.toThrow(
      "Retry to resume the same message"
    );
    expect(loadWormholeHint(output, expected)).toEqual(publication());
    globalThis.fetch = fetchFixture(async () => new Response("", { status: 404 }));
    expect(await findWormholePublication(output, expected)).toEqual(publication());
    expect(fixture.state.writes).toHaveLength(1);
  });
  test("scan shrinks to 1000-block chunks and exhausts only the newest 50000 blocks", async () => {
    fixture.state.maxRange = 1000n;
    fixture.state.latest = 80_000n;
    fixture.state.events = [];
    expect(await findWormholePublication(output, expected)).toBeNull();
    const widths = fixture.state.queries.map((query) => query.toBlock - query.fromBlock + 1n);
    expect(widths.slice(0, 5)).toEqual([10_000n, 5_000n, 2_500n, 1_250n, 1_000n]);
    expect(fixture.state.queries.at(-1)!.fromBlock).toBe(30_001n);
  });
  test("RPC history failure is unavailable, not permission to publish", async () => {
    fixture.state.failHistory = true;
    await expect(findWormholePublication(output, expected)).rejects.toThrow("history unavailable");
    expect(
      fixture.state.queries.at(-1)!.toBlock - fixture.state.queries.at(-1)!.fromBlock + 1n
    ).toBe(1000n);
    fixture.state.failHistory = false;
    expect(await findWormholePublication(output, expected)).toEqual(publication());
    expect(fixture.state.writes).toHaveLength(0);
  });
  test("scanned-through cache retains candidates but refreshes receipt authority", async () => {
    expect(await findWormholePublication(output, expected)).toEqual(publication());
    const firstQueries = fixture.state.queries.length;
    clearWormholeHint(output, expected);
    fixture.state.latest++;
    expect(await findWormholePublication(output, expected)).toEqual(publication());
    expect(fixture.state.queries).toHaveLength(firstQueries + 1);
    expect(fixture.state.queries.at(-1)).toMatchObject({ fromBlock: 50_001n, toBlock: 50_001n });
    expect(fixture.state.receiptsRead.filter((hash) => hash === tx(1)).length).toBeGreaterThan(1);
    fixture.state.receipts.set(tx(1), receipt([], tx(1), false));
    expect(await findWormholePublication(output, expected)).toBeNull();
  });
  test("a different exact payload gets its own scan, not the first payload's cache", async () => {
    expect(await findWormholePublication(output, expected)).toEqual(publication());
    const firstQueries = fixture.state.queries.length;
    const other = encodeNotFilledDescription({
      orderId: b32("a"),
      output,
      fillDeadline: TEST_NOW_SECONDS
    });
    expect(
      await findWormholePublication(output, { application: output.settler, payload: other })
    ).toBeNull();
    expect(fixture.state.queries.length).toBeGreaterThan(firstQueries);
  });
  test("duplicate matching Core logs remain ambiguous during hint recovery", async () => {
    fixture.state.receipts.set(
      tx(1),
      receipt([messageLog(), messageLog({ sequence: SEQUENCE + 1n, index: 1 })])
    );
    await expect(findWormholePublication(output, expected, publication())).rejects.toThrow(
      "Ambiguous"
    );
  });
});
