import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { base58, base64 } from "@scure/base";
import {
  encodeFillDescription,
  encodeNotFilledDescription,
  SOLANA_MAINNET_CHAIN_ID
} from "@lifi/intent";
import {
  AddressLookupTableAccount,
  Connection,
  Message,
  MessageV0,
  PublicKey
} from "@solana/web3.js";
import type {
  AccountInfo,
  ConfirmedSignatureInfo,
  GetTransactionConfig,
  GetVersionedTransactionConfig,
  TransactionResponse,
  VersionedTransactionResponse
} from "@solana/web3.js";
import { createVAA, serialize, UniversalAddress } from "@wormhole-foundation/sdk-definitions";
import { hexToBytes } from "viem";
import type { Hex } from "viem";
import { SOLANA_OUTPUT_SETTLER, WORMHOLE_ORACLE } from "../../src/lib/config";
import { INTENTS_PROTOCOL_PROGRAM_ID } from "../../src/lib/idl";
import { SOLANA_GENESIS_HASHES } from "../../src/lib/solana/client";
import { localAttestationDataHash } from "../../src/lib/solana/encode";
import { LOCAL_ATTESTATION_DISCRIMINATOR } from "../../src/lib/solana/nonFill";
import {
  bytes32ToPubkey,
  localAttestationPda,
  outputSettlerSimplePda
} from "../../src/lib/solana/pda";
import type { WormholePublication } from "../../src/lib/libraries/wormholeProof";
import {
  findSolanaWormholePublication,
  verifySolanaWormholePublication
} from "../../src/lib/libraries/wormholeSolanaRecovery";
import {
  findWormholePublication,
  loadWormholeHint,
  saveWormholeMessageAccount
} from "../../src/lib/libraries/wormholePublication";
import { b32, makeMandateOutput, TEST_NOW_SECONDS } from "../fixtures/orderFixtures";

const PROGRAM = new PublicKey("LiFixrxyzmt1Degd42wQCsQNhDNLjbrRwtwopX5VUrt");
const CORE = new PublicKey("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");
const oracle = WORMHOLE_ORACLE[Number(SOLANA_MAINNET_CHAIN_ID)]!;
const EMITTER = bytes32ToPubkey(oracle);
const MESSAGE = new PublicKey(new Uint8Array(32).fill(7));
const MESSAGE_OLDER = new PublicKey(new Uint8Array(32).fill(8));
const LOOKUP_TABLE = new PublicKey(new Uint8Array(32).fill(10));
const output = makeMandateOutput(SOLANA_MAINNET_CHAIN_ID, 123n, {
  oracle,
  settler: SOLANA_OUTPUT_SETTLER
});
const orderId = b32("a");
const solver = b32("b");
const payload = encodeFillDescription({ orderId, solver, output, timestamp: TEST_NOW_SECONDS });
const expected = { application: output.settler, payload };
const localAddress = localAttestationPda(
  outputSettlerSimplePda(),
  oracle,
  localAttestationDataHash({ orderId, solver, output })
).toBase58();
const unavailable =
  "Wormhole publication history unavailable. Retry with an archival RPC or the publication transaction.";

function envelope(payloads: Hex[] = [payload], application = output.settler): Uint8Array {
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

function account(data: Uint8Array, owner = CORE, executable = false): AccountInfo<Buffer> {
  return { data: Buffer.from(data), owner, executable, lamports: 1, rentEpoch: 0 };
}
function localAccount(consumed = false): AccountInfo<Buffer> {
  const bytes = new Uint8Array(46);
  bytes.set(LOCAL_ATTESTATION_DISCRIMINATOR);
  new DataView(bytes.buffer).setUint32(8, TEST_NOW_SECONDS, true);
  bytes.set(new Uint8Array(32).fill(9), 13);
  bytes[45] = consumed ? 1 : 0;
  return account(bytes, new PublicKey(INTENTS_PROTOCOL_PROGRAM_ID));
}

type MessageOptions = {
  sequence?: bigint;
  nonce?: number;
  emitterChain?: number;
  emitter?: Hex;
  consistency?: number;
  timestamp?: number;
  body?: Uint8Array;
};
function messageData(options: MessageOptions = {}): Uint8Array {
  const body = options.body ?? envelope();
  const bytes = new Uint8Array(95 + body.length);
  bytes.set([109, 115, 103, 1]);
  bytes[4] = options.consistency ?? 32;
  bytes.set(hexToBytes(oracle), 5);
  const view = new DataView(bytes.buffer);
  view.setUint32(41, options.timestamp ?? TEST_NOW_SECONDS + 10, true);
  view.setUint32(45, options.nonce ?? 0, true);
  view.setBigUint64(49, options.sequence ?? 9007199254740993n, true);
  view.setUint16(57, options.emitterChain ?? 1, true);
  bytes.set(hexToBytes(options.emitter ?? oracle), 59);
  view.setUint32(91, body.length, true);
  bytes.set(body, 95);
  return bytes;
}
function signedVaa(
  sequence: bigint,
  body = envelope(),
  timestamp = TEST_NOW_SECONDS + 10
): Uint8Array {
  const unsigned = serialize(
    createVAA("Uint8Array", {
      guardianSet: 0,
      signatures: [],
      timestamp,
      nonce: 0,
      emitterChain: "Solana",
      emitterAddress: new UniversalAddress(hexToBytes(oracle)),
      sequence,
      consistencyLevel: 32,
      payload: body
    })
  );
  // Structurally valid fixture only; actual guardian verification belongs to Core.
  const bytes = new Uint8Array(unsigned.length + 66);
  bytes.set(unsigned.subarray(0, 6));
  bytes[5] = 1;
  bytes.set(unsigned.subarray(6), 72);
  return bytes;
}
function publication(
  sequence = "9007199254740993",
  messageAccount = MESSAGE.toBase58()
): WormholePublication {
  return {
    id: { network: "mainnet", emitterChain: 1, emitter: oracle, sequence },
    nonce: 0,
    consistencyLevel: 32,
    messageAccount
  };
}
function signature(
  index: number,
  blockTime: number | null = TEST_NOW_SECONDS + 20
): ConfirmedSignatureInfo {
  return {
    signature: base58.encode(new Uint8Array(64).fill(index)),
    slot: index,
    err: null,
    memo: null,
    blockTime,
    confirmationStatus: "confirmed"
  };
}
function transaction(messageAccount = MESSAGE, versioned = false): VersionedTransactionResponse {
  const keys = [EMITTER, CORE, messageAccount];
  const header = {
    numRequiredSignatures: 1,
    numReadonlySignedAccounts: 0,
    numReadonlyUnsignedAccounts: 1
  };
  const message = versioned
    ? new MessageV0({
        header: { ...header, numReadonlyUnsignedAccounts: 0 },
        staticAccountKeys: [EMITTER],
        recentBlockhash: EMITTER.toBase58(),
        compiledInstructions: [],
        addressTableLookups: [
          { accountKey: LOOKUP_TABLE, writableIndexes: [0, 1], readonlyIndexes: [] }
        ]
      })
    : new Message({
        header,
        accountKeys: keys,
        recentBlockhash: EMITTER.toBase58(),
        instructions: []
      });
  return {
    slot: 1,
    blockTime: TEST_NOW_SECONDS + 20,
    transaction: { signatures: [], message },
    meta: {
      err: null,
      fee: 1,
      preBalances: [],
      postBalances: [],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            { programIdIndex: 1, accounts: [0, 2, 0], data: base58.encode(new Uint8Array([1])) }
          ]
        }
      ],
      ...(versioned ? { loadedAddresses: { writable: [CORE, messageAccount], readonly: [] } } : {})
    }
  };
}

describe("Solana Wormhole publication recovery", () => {
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const transactions = new Map<string, VersionedTransactionResponse | null>();
  function getTransactionFixture(
    signature: string,
    config?: GetTransactionConfig
  ): Promise<TransactionResponse | null>;
  function getTransactionFixture(
    signature: string,
    config: GetVersionedTransactionConfig
  ): Promise<VersionedTransactionResponse | null>;
  async function getTransactionFixture(
    signature: string,
    config?: GetTransactionConfig | GetVersionedTransactionConfig
  ): Promise<TransactionResponse | VersionedTransactionResponse | null> {
    const transaction = transactions.get(signature) ?? null;
    if (!transaction || (config && "maxSupportedTransactionVersion" in config)) return transaction;
    const message = transaction.transaction.message;
    if (message.version !== "legacy")
      throw new Error("Versioned transaction requires a supported transaction version.");
    return { ...transaction, transaction: { ...transaction.transaction, message } };
  }
  const signed = new Map<string, Uint8Array>();
  const pages = new Map<string, ConfirmedSignatureInfo[]>();
  let scanPages: Uint8Array[][];
  let historyFailure: boolean;
  let scanFailure: boolean;
  let requests: string[];
  let accountReads: string[];
  let cursors: (string | undefined)[];
  const restorers: { mockRestore(): void }[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    accounts.clear();
    transactions.clear();
    signed.clear();
    pages.clear();
    scanPages = [];
    historyFailure = false;
    scanFailure = false;
    requests = [];
    accountReads = [];
    cursors = [];
    const state = new Uint8Array(89);
    state.set(hexToBytes("0xdacfeebe62a303c7"));
    state.set(CORE.toBytes(), 40);
    accounts.set(EMITTER.toBase58(), account(state, PROGRAM));
    accounts.set(PROGRAM.toBase58(), account(new Uint8Array(), PROGRAM, true));
    accounts.set(CORE.toBase58(), account(new Uint8Array(), CORE, true));
    accounts.set(localAddress, localAccount());
    restorers.push(
      spyOn(Connection.prototype, "getGenesisHash").mockResolvedValue(
        SOLANA_GENESIS_HASHES[SOLANA_MAINNET_CHAIN_ID.toString()]!
      )
    );
    restorers.push(
      spyOn(Connection.prototype, "getAccountInfo").mockImplementation(async (key) => {
        accountReads.push(key.toBase58());
        return accounts.get(key.toBase58()) ?? null;
      })
    );
    restorers.push(
      spyOn(Connection.prototype, "getSignaturesForAddress").mockImplementation(
        async (_key, options) => {
          cursors.push(options?.before);
          if (historyFailure) throw new Error("pruned RPC");
          expect(options?.limit).toBe(20);
          return pages.get(options?.before ?? "") ?? [];
        }
      )
    );
    restorers.push(
      spyOn(Connection.prototype, "getTransaction").mockImplementation(getTransactionFixture)
    );
    restorers.push(
      spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0]) => {
            const url = String(input);
            requests.push(url);
            if (url.includes("/v1/signed_vaa/")) {
              const bytes = signed.get(url.split("/").at(-1)!);
              return bytes
                ? Response.json({ vaaBytes: base64.encode(bytes) })
                : new Response(null, { status: 404 });
            }
            if (scanFailure) return new Response(null, { status: 500 });
            const page = Number(new URL(url).searchParams.get("page"));
            return Response.json({
              data: (scanPages[page] ?? []).map((bytes) => ({ vaa: base64.encode(bytes) }))
            });
          },
          { preconnect: originalFetch.preconnect }
        )
      )
    );
  });
  afterEach(() => {
    for (const restorer of restorers.splice(0)) restorer.mockRestore();
  });

  test("retained Core account is read before history and reconstructs uint64 identity", async () => {
    accounts.set(MESSAGE.toBase58(), account(messageData()));
    const result = await findSolanaWormholePublication(output, expected, publication("1"));
    expect(result).toEqual(publication());
    expect(accountReads.indexOf(MESSAGE.toBase58())).toBeLessThan(
      accountReads.indexOf(localAddress)
    );
    expect(requests[0]).toEndWith("/9007199254740993");
  });

  test.each([
    ["wrong owner", account(messageData(), PROGRAM)],
    ["wrong emitter", account(messageData({ emitter: b32("d") }))],
    ["wrong native chain", account(messageData({ emitterChain: 2 }))],
    ["wrong nonce", account(messageData({ nonce: 7 }))],
    ["wrong application", account(messageData({ body: envelope([payload], b32("c")) }))],
    [
      "different solver",
      account(
        messageData({
          body: envelope([
            encodeFillDescription({
              orderId,
              solver: b32("c"),
              output,
              timestamp: TEST_NOW_SECONDS
            })
          ])
        })
      )
    ],
    ["truncated envelope", account(messageData({ body: envelope().subarray(0, 40) }))]
  ])("untrusted %s hint cannot become a publication", async (_label, bad) => {
    accounts.set(MESSAGE.toBase58(), bad);
    expect(await findSolanaWormholePublication(output, expected, publication())).toBeNull();
    expect(requests).toHaveLength(0);
  });

  test("malformed or nonexistent hints rediscover without poisoning complete history", async () => {
    for (const hint of [{ ...publication(), messageAccount: "not-base58" }, publication()]) {
      expect(await findSolanaWormholePublication(output, expected, hint)).toBeNull();
    }
  });

  test("pending public account locator recovers without a predicted message identity", async () => {
    accounts.set(MESSAGE.toBase58(), account(messageData()));
    accounts.set(MESSAGE_OLDER.toBase58(), account(messageData({ sequence: 1n })));
    const result = await findSolanaWormholePublication(
      output,
      expected,
      publication("1", MESSAGE_OLDER.toBase58()),
      MESSAGE.toBase58()
    );
    expect(result?.id.sequence).toBe("9007199254740993");
    expect(accountReads.indexOf(MESSAGE.toBase58())).toBeLessThan(
      accountReads.indexOf(MESSAGE_OLDER.toBase58())
    );
    expect(
      await findSolanaWormholePublication(output, expected, undefined, "invalid-locator")
    ).toBeNull();
  });

  test("shared pending locator survives reload and public discovery reconstructs actual identity", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const items = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return items.size;
      },
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        items.set(key, value);
      },
      removeItem: (key) => {
        items.delete(key);
      },
      clear: () => {
        items.clear();
      },
      key: (index) => Array.from(items.keys())[index] ?? null
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    try {
      accounts.set(MESSAGE.toBase58(), account(messageData()));
      saveWormholeMessageAccount(output, expected, MESSAGE.toBase58());
      expect(loadWormholeHint(output, expected)).toBeUndefined();
      expect(JSON.parse(Array.from(items.values())[0]!)).toEqual({
        messageAccount: MESSAGE.toBase58()
      });
      const result = await findWormholePublication(output, expected);
      expect(result).toEqual(publication());
      expect(loadWormholeHint(output, expected)).toEqual(publication());
      expect(requests[0]).toEndWith("/9007199254740993");
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("pages beyond twenty successful signatures and follows before cursors", async () => {
    const first = Array.from({ length: 20 }, (_, i) => signature(i + 1));
    const last = signature(21);
    pages.set("", first);
    pages.set(first[19]!.signature, [last]);
    for (const entry of first)
      transactions.set(entry.signature, {
        ...transaction(),
        meta: { ...transaction().meta!, innerInstructions: [] }
      });
    transactions.set(last.signature, transaction());
    accounts.set(MESSAGE.toBase58(), account(messageData()));
    expect((await findSolanaWormholePublication(output, expected))?.txRef).toBe(last.signature);
    expect(cursors).toEqual([undefined, first[19]!.signature, last.signature]);
  });

  test("resolves versioned loaded addresses instead of unrelated Sequence logs", async () => {
    const entry = signature(1);
    pages.set("", [entry]);
    const tx = transaction(MESSAGE, true);
    tx.meta!.logMessages = ["Program log: Sequence: 1", "Program log: Sequence: 999"];
    transactions.set(entry.signature, tx);
    accounts.set(MESSAGE.toBase58(), account(messageData()));
    expect((await findSolanaWormholePublication(output, expected))?.id.sequence).toBe(
      "9007199254740993"
    );
  });

  test("stops before the tagged proof timestamp and skips failed transactions", async () => {
    const failed = { ...signature(1), err: { InstructionError: [0, "InvalidArgument"] } };
    const old = signature(2, TEST_NOW_SECONDS - 1);
    pages.set("", [failed, old, signature(3)]);
    expect(await findSolanaWormholePublication(output, expected)).toBeNull();
    expect(cursors).toEqual([undefined]);
  });

  test("resolves lookup tables when versioned loaded addresses are absent", async () => {
    const entry = signature(1);
    pages.set("", [entry]);
    const tx = transaction(MESSAGE, true);
    delete tx.meta!.loadedAddresses;
    transactions.set(entry.signature, tx);
    accounts.set(MESSAGE.toBase58(), account(messageData()));
    const table = new AddressLookupTableAccount({
      key: LOOKUP_TABLE,
      state: {
        deactivationSlot: 0xffffffffffffffffn,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: [CORE, MESSAGE]
      }
    });
    const lookup = spyOn(Connection.prototype, "getAddressLookupTable").mockResolvedValue({
      context: { slot: 1 },
      value: table
    });
    restorers.push(lookup);
    expect((await findSolanaWormholePublication(output, expected))?.id.sequence).toBe(
      "9007199254740993"
    );
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test("unresolvable versioned keys remain unavailable, never enable republishing", async () => {
    const entry = signature(1);
    pages.set("", [entry]);
    const tx = transaction(MESSAGE, true);
    delete tx.meta!.loadedAddresses;
    transactions.set(entry.signature, tx);
    restorers.push(
      spyOn(Connection.prototype, "getAddressLookupTable").mockResolvedValue({
        context: { slot: 1 },
        value: null
      })
    );
    await expect(findSolanaWormholePublication(output, expected)).rejects.toThrow(unavailable);
  });

  test("history failure never becomes publishable null", async () => {
    historyFailure = true;
    await expect(findSolanaWormholePublication(output, expected)).rejects.toThrow(unavailable);
  });

  test("pruned post-message account recovers a consumed publication from Scan", async () => {
    accounts.set(localAddress, localAccount(true));
    const entry = signature(1);
    pages.set("", [entry]);
    transactions.set(entry.signature, transaction());
    scanPages = [[signedVaa(9007199254740993n)]];
    const result = await findSolanaWormholePublication(output, expected);
    expect(result?.id.sequence).toBe("9007199254740993");
    expect(result?.messageAccount).toBeUndefined();
    expect(requests.some((url) => url.includes(`/api/v1/vaas/1/${oracle.slice(2)}`))).toBe(true);
  });

  test("a pending verified publication never switches transports or republishes", async () => {
    accounts.set(localAddress, localAccount(true));
    accounts.set(MESSAGE.toBase58(), account(messageData()));
    expect(await findSolanaWormholePublication(output, expected, publication())).toEqual(
      publication()
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("/v1/signed_vaa/");
  });

  test("absent non-fill record is publishable only after complete recovery search", async () => {
    const nonFill = encodeNotFilledDescription({ orderId, output, fillDeadline: TEST_NOW_SECONDS });
    expect(
      await findSolanaWormholePublication(output, { ...expected, payload: nonFill })
    ).toBeNull();
    expect(requests.some((url) => url.includes("/api/v1/vaas/"))).toBe(true);
    scanFailure = true;
    await expect(
      findSolanaWormholePublication(output, { ...expected, payload: nonFill })
    ).rejects.toThrow(unavailable);
  });

  test("wrong-emitter Scan candidates cannot recover consumed local records", async () => {
    accounts.set(localAddress, localAccount(true));
    const bytes = signedVaa(10n);
    bytes[82] ^= 1;
    scanPages = [[bytes]];
    await expect(findSolanaWormholePublication(output, expected)).rejects.toThrow(unavailable);
  });

  test("malformed Scan VAA header stays unavailable rather than inventing eligibility", async () => {
    historyFailure = true;
    scanPages = [[new Uint8Array([1, 0])]];
    await expect(findSolanaWormholePublication(output, expected)).rejects.toThrow(unavailable);
  });

  test("Scan checks every batch payload and chooses newest exact match across pages", async () => {
    historyFailure = true;
    const other = encodeNotFilledDescription({ orderId, output, fillDeadline: TEST_NOW_SECONDS });
    scanPages = [
      Array.from({ length: 20 }, (_, i) => signedVaa(BigInt(100 - i), envelope([other]))),
      [signedVaa(79n, envelope([other, payload])), signedVaa(78n)]
    ];
    expect((await findSolanaWormholePublication(output, expected))?.id.sequence).toBe("79");
    expect(requests.filter((url) => url.includes("/api/v1/vaas/"))).toHaveLength(2);
  });

  test("Scan uses parsed VAA timestamps, not untrusted index timestamp fields", async () => {
    historyFailure = true;
    scanPages = [[signedVaa(10n, envelope(), TEST_NOW_SECONDS - 1)]];
    await expect(findSolanaWormholePublication(output, expected)).rejects.toThrow(unavailable);
    expect(requests.filter((url) => url.includes("/api/v1/vaas/"))).toHaveLength(1);
  });

  test("newest signed publication wins over newer pending publication", async () => {
    const entry = signature(1);
    pages.set("", [entry]);
    const tx = transaction();
    const legacy = tx.transaction.message as Message;
    const header = legacy.header;
    tx.transaction.message = new Message({
      header,
      accountKeys: [EMITTER, CORE, MESSAGE, MESSAGE_OLDER],
      recentBlockhash: EMITTER.toBase58(),
      instructions: []
    });
    tx.meta!.innerInstructions![0]!.instructions.push({
      programIdIndex: 1,
      accounts: [0, 3, 0],
      data: base58.encode(new Uint8Array([1]))
    });
    transactions.set(entry.signature, tx);
    accounts.set(MESSAGE.toBase58(), account(messageData({ sequence: 12n })));
    accounts.set(MESSAGE_OLDER.toBase58(), account(messageData({ sequence: 11n })));
    signed.set("11", signedVaa(11n));
    expect((await findSolanaWormholePublication(output, expected))?.id.sequence).toBe("11");
  });

  test("consumed/closed fill and unavailable Scan cannot be republished", async () => {
    accounts.delete(localAddress);
    scanFailure = true;
    await expect(findSolanaWormholePublication(output, expected)).rejects.toThrow(unavailable);
  });

  test("fabricated output bytes fail before RPC history or Scan", async () => {
    const changed = encodeFillDescription({
      orderId,
      solver,
      output: { ...output, amount: 124n },
      timestamp: TEST_NOW_SECONDS
    });
    await expect(
      findSolanaWormholePublication(output, { ...expected, payload: changed })
    ).rejects.toThrow("exact signed output");
    expect(cursors).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test("verify helper rechecks account consistency and rejects altered publication identity", async () => {
    accounts.set(MESSAGE.toBase58(), account(messageData()));
    expect(await verifySolanaWormholePublication(output, expected, publication())).toEqual(
      publication()
    );
    expect(
      await verifySolanaWormholePublication(output, expected, {
        ...publication(),
        nonce: 7,
        consistencyLevel: 1
      })
    ).toEqual(publication());
    expect(await verifySolanaWormholePublication(output, expected, publication("1"))).toBeNull();
  });

  test("Scan-only verification binds all fields without trusting source tx/account hints", async () => {
    const candidate = publication();
    delete candidate.messageAccount;
    signed.set(candidate.id.sequence, signedVaa(BigInt(candidate.id.sequence)));
    expect(await verifySolanaWormholePublication(output, expected, candidate)).toEqual(candidate);
    expect(
      await verifySolanaWormholePublication(output, expected, {
        ...candidate,
        nonce: 7,
        consistencyLevel: 1
      })
    ).toEqual(candidate);
  });

  test("RPC genesis or mutated oracle state cannot recover a trusted publication", async () => {
    accounts.get(EMITTER.toBase58())!.data[40] ^= 1;
    await expect(findSolanaWormholePublication(output, expected)).rejects.toThrow("state/Core");
  });
});
