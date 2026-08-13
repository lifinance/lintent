import { describe, expect, test } from "bun:test";
import { getOutputHash } from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import {
  INPUT_SETTLER_ESCROW_PROGRAM_ID,
  INTENTS_PROTOCOL_PROGRAM_ID,
  OUTPUT_SETTLER_SIMPLE_PROGRAM_ID
} from "../../src/lib/idl";
import { localAttestationDataHash } from "../../src/lib/solana/encode";
import {
  attestationPda,
  bytes32ToPubkey,
  consumedOrderPda,
  fillIdPda,
  localAttestationPda,
  orderContextPda,
  outputSettlerSimplePda
} from "../../src/lib/solana/pda";
import {
  readIsLocallyAttested,
  readIsOrderFinalised,
  readIsOrderOpen,
  readIsOutputFilled,
  readIsProvenOnSolana,
  readSplBalance
} from "../../src/lib/solana/reads";
import type { SolanaAccountInfoLike, SolanaConnectionLike } from "../../src/lib/solana/types";

const b32 = (nibble: string) => `0x${nibble.repeat(64)}` as `0x${string}`;
const ORDER_ID = b32("6");
const SOLVER = b32("5");

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

function makeOutput(overrides: Partial<MandateOutput> = {}): MandateOutput {
  return {
    oracle: b32("1"),
    settler: b32("2"),
    chainId: 1151111081099712n,
    token: b32("3"),
    amount: 1_000_000n,
    recipient: b32("4"),
    callbackData: "0x",
    context: "0x",
    ...overrides
  } as MandateOutput;
}

/**
 * A connection whose accounts are whatever the test says they are. Built by
 * hand against SolanaConnectionLike — no @solana/web3.js in the test process,
 * which is the point of the DI seam.
 */
function makeReads(accounts: Record<string, { owner: string }> = {}) {
  const requested: string[] = [];
  const reads: SolanaConnectionLike = {
    rpcEndpoint: "https://test.invalid",
    getGenesisHash: async () => "genesis",
    getAccountInfo: async (address) => {
      requested.push(address);
      const account = accounts[address];
      return account
        ? ({ owner: account.owner, lamports: 1, data: new Uint8Array() } as SolanaAccountInfoLike)
        : null;
    },
    getMultipleAccountsInfo: async (addresses) => {
      requested.push(...addresses);
      return addresses.map((address) => {
        const account = accounts[address];
        return account
          ? ({ owner: account.owner, lamports: 1, data: new Uint8Array() } as SolanaAccountInfoLike)
          : null;
      });
    },
    getTransaction: async () => null,
    getBalance: async () => 0n,
    getTokenAccountBalance: async () => 0n,
    getLatestBlockhash: async () => ({ blockhash: "hash", lastValidBlockHeight: 1 })
  };
  return { reads, requested };
}

describe("readIsOutputFilled", () => {
  const output = makeOutput();
  const fillId = fillIdPda(ORDER_ID, getOutputHash(output)).toBase58();

  test("true when the FillId account is owned by the output settler", () => {
    const { reads } = makeReads({ [fillId]: { owner: OUTPUT_SETTLER_SIMPLE_PROGRAM_ID } });
    return expect(readIsOutputFilled(reads, { orderId: ORDER_ID, output })).resolves.toBe(true);
  });

  test("false when the account is absent", () => {
    const { reads } = makeReads();
    return expect(readIsOutputFilled(reads, { orderId: ORDER_ID, output })).resolves.toBe(false);
  });

  test("false when the account exists but is not owned by the settler", async () => {
    // Anyone can create a system-owned account at a known PDA address by
    // sending it rent. Without the owner check that would read as a fill.
    const { reads } = makeReads({ [fillId]: { owner: SYSTEM_PROGRAM } });
    expect(await readIsOutputFilled(reads, { orderId: ORDER_ID, output })).toBe(false);
  });

  test("queries the FillId PDA for the given order and output", async () => {
    const { reads, requested } = makeReads();
    await readIsOutputFilled(reads, { orderId: ORDER_ID, output });
    expect(requested).toEqual([fillId]);
  });
});

describe("readIsLocallyAttested", () => {
  const output = makeOutput();
  const dataHash = localAttestationDataHash({ solver: SOLVER, orderId: ORDER_ID, output });
  const pda = localAttestationPda(outputSettlerSimplePda(), output.oracle, dataHash).toBase58();

  test("true when the protocol owns the LocalAttestation account", async () => {
    const { reads } = makeReads({ [pda]: { owner: INTENTS_PROTOCOL_PROGRAM_ID } });
    expect(await readIsLocallyAttested(reads, { orderId: ORDER_ID, output, solver: SOLVER })).toBe(
      true
    );
  });

  test("false for a different solver", async () => {
    // The solver is inside the data hash, so a different one derives a
    // different account entirely.
    const { reads } = makeReads({ [pda]: { owner: INTENTS_PROTOCOL_PROGRAM_ID } });
    expect(
      await readIsLocallyAttested(reads, { orderId: ORDER_ID, output, solver: b32("7") })
    ).toBe(false);
  });
});

describe("readIsProvenOnSolana", () => {
  const output = makeOutput();
  const inputOracle = b32("8");
  const payloadHash = b32("9");
  const pda = attestationPda(
    bytes32ToPubkey(inputOracle),
    output.chainId,
    output.oracle,
    output.settler,
    payloadHash
  ).toBase58();

  test("true when the attestation account exists", async () => {
    const { reads } = makeReads({ [pda]: { owner: INTENTS_PROTOCOL_PROGRAM_ID } });
    expect(await readIsProvenOnSolana(reads, { inputOracle, output, payloadHash })).toBe(true);
  });

  test("false when the payload hash differs", async () => {
    const { reads } = makeReads({ [pda]: { owner: INTENTS_PROTOCOL_PROGRAM_ID } });
    expect(await readIsProvenOnSolana(reads, { inputOracle, output, payloadHash: b32("a") })).toBe(
      false
    );
  });
});

describe("order lifecycle", () => {
  const context = orderContextPda(ORDER_ID).toBase58();
  const consumed = consumedOrderPda(ORDER_ID).toBase58();
  const owner = INPUT_SETTLER_ESCROW_PROGRAM_ID;

  test("open while the order context exists", async () => {
    const { reads } = makeReads({ [context]: { owner }, [consumed]: { owner } });
    expect(await readIsOrderOpen(reads, ORDER_ID)).toBe(true);
    expect(await readIsOrderFinalised(reads, ORDER_ID)).toBe(false);
  });

  test("terminal once the context is closed but consumed_order remains", async () => {
    // finalise and refund both close order_context; consumed_order is never
    // closed, so this pair is the only signal that the order ran to an end.
    const { reads } = makeReads({ [consumed]: { owner } });
    expect(await readIsOrderOpen(reads, ORDER_ID)).toBe(false);
    expect(await readIsOrderFinalised(reads, ORDER_ID)).toBe(true);
  });

  test("not finalised when the order was never opened", async () => {
    // Both accounts absent means "unknown order", not "already settled" —
    // otherwise a typo'd order id would render as complete.
    const { reads } = makeReads();
    expect(await readIsOrderFinalised(reads, ORDER_ID)).toBe(false);
  });
});

describe("readSplBalance", () => {
  test("returns zero when the associated token account does not exist", async () => {
    // An unfunded ATA is a zero balance, not a failure.
    const { reads } = makeReads();
    expect(
      await readSplBalance(reads, { mintBytes32: b32("3"), ownerBase58: SYSTEM_PROGRAM })
    ).toBe(0n);
  });
});
