/**
 * Unit tests for the Solana-specific branches in flowProgress.ts:
 *   - isOutputValidatedOnChain: checks attestation PDA existence on Solana
 *   - isInputChainFinalised: checks order_context PDA closure on Solana
 *
 * Strategy: mock heavy dependencies (config, rpcCache, solana libs, viem).
 * getAccountInfo uses a response-queue (FIFO) so tests control each call's
 * result without inspecting the PublicKey object — avoiding @solana/web3.js mock bleeding.
 *
 * Call order within getOrderProgressChecks (1 output, 1 Solana input chain):
 *   1. attestation PDA check  (isOutputValidatedOnChain)
 *   2. order_context PDA check (isInputChainFinalised, only if step 1 returned true)
 */
import { describe, expect, it, mock, beforeAll, beforeEach } from "bun:test";
import type { MandateOutput, OrderContainer, StandardSolana } from "@lifi/intent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOLANA_DEVNET_CHAIN_ID = 1151111081099712n;
const BASE_SEPOLIA_CHAIN_ID = 84532n;

const FAKE_ORACLE = ("0x" + "ab".repeat(32)) as `0x${string}`;
const FAKE_SETTLER = ("0x" + "cd".repeat(32)) as `0x${string}`;
const FAKE_TOKEN = ("0x" + "ef".repeat(32)) as `0x${string}`;
const FAKE_RECIPIENT = ("0x" + "12".repeat(32)) as `0x${string}`;
const FAKE_SOLVER = ("0x" + "aa".repeat(32)) as `0x${string}`;
const FAKE_ORDER_ID = ("0x" + "bb".repeat(32)) as `0x${string}`;
const FAKE_TX_HASH = ("0x" + "cc".repeat(32)) as `0x${string}`;
const FAKE_ATTESTATION_PDA = "11111111111111111111111111111112";
const FAKE_ORDER_CONTEXT_PDA = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const fakeOutput: MandateOutput = {
	oracle: FAKE_ORACLE,
	settler: FAKE_SETTLER,
	chainId: BASE_SEPOLIA_CHAIN_ID,
	token: FAKE_TOKEN,
	amount: 1_000_000n,
	recipient: FAKE_RECIPIENT,
	callbackData: "0x",
	context: "0x"
};

const fakeSolanaOrder: StandardSolana = {
	user: ("0x" + "aa".repeat(20)) as `0x${string}`,
	nonce: 1n,
	originChainId: SOLANA_DEVNET_CHAIN_ID,
	expires: 2000000000,
	fillDeadline: 1999999999,
	inputOracle: ("0x" + "bb".repeat(20)) as `0x${string}`,
	inputs: [[BigInt("0x" + "ef".repeat(32)), 1_000_000n]],
	outputs: [fakeOutput]
};

const fakeContainer: OrderContainer = {
	inputSettler: ("0x" + "11".repeat(20)) as `0x${string}`,
	order: fakeSolanaOrder,
	sponsorSignature: { type: "None", payload: "0x" },
	allocatorSignature: { type: "None", payload: "0x" }
};

// ---------------------------------------------------------------------------
// Response queue for getAccountInfo
//
// Each test pushes the expected responses in order. getAccountInfo shifts one
// off the front per call. This avoids inspecting the PublicKey object and
// doesn't require mocking @solana/web3.js at all.
// ---------------------------------------------------------------------------

const accountInfoQueue: (object | null)[] = [];

beforeEach(() => {
	accountInfoQueue.length = 0;
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

beforeAll(() => {
	mock.module("$lib/config", () => ({
		isSolanaChain: (chainId: bigint) => chainId === SOLANA_DEVNET_CHAIN_ID,
		getSolanaConnection: () => ({
			getAccountInfo: async () => accountInfoQueue.shift() ?? null
		}),
		getClient: () => ({
			readContract: async ({ functionName }: { functionName: string }) => {
				if (functionName === "getFillRecord") return ("0x" + "ff".repeat(32)) as `0x${string}`;
				return true;
			},
			getTransactionReceipt: async () => ({
				blockHash: ("0x" + "aa".repeat(32)) as `0x${string}`,
				from: ("0x" + "bb".repeat(20)) as `0x${string}`,
				logs: []
			}),
			getBlock: async () => ({ timestamp: 1_700_000_000n })
		}),
		BYTES32_ZERO: "0x" + "00".repeat(32),
		INPUT_SETTLER_ESCROW_LIFI: "0x" + "22".repeat(20),
		INPUT_SETTLER_COMPACT_LIFI: "0x" + "33".repeat(20),
		MULTICHAIN_INPUT_SETTLER_ESCROW: "0x" + "44".repeat(20),
		MULTICHAIN_INPUT_SETTLER_COMPACT: "0x" + "55".repeat(20),
		COMPACT: "0x" + "66".repeat(20)
	}));

	mock.module("$lib/libraries/rpcCache", () => ({
		getOrFetchRpc: async (_key: string, fn: () => Promise<unknown>) => fn()
	}));

	mock.module("$lib/libraries/solanaValidateLib", () => ({
		deriveAttestationPda: async () => FAKE_ATTESTATION_PDA
	}));

	mock.module("$lib/libraries/solanaFinaliseLib", () => ({
		deriveOrderContextPda: async () => FAKE_ORDER_CONTEXT_PDA
	}));

	mock.module("$lib/utils/intent", () => ({
		containerToIntent: () => ({
			orderId: () => FAKE_ORDER_ID,
			inputChains: () => [SOLANA_DEVNET_CHAIN_ID]
		})
	}));

	mock.module("viem", () => ({
		hashStruct: () => FAKE_ORDER_ID,
		keccak256: () => FAKE_ORDER_ID,
		parseEventLogs: () => [
			{
				args: { output: fakeOutput, solver: FAKE_SOLVER, timestamp: 1_700_000_000 },
				address: FAKE_SETTLER
			}
		]
	}));

	mock.module("@lifi/intent", () => ({
		compactTypes: {},
		getOutputHash: () => FAKE_ORDER_ID,
		encodeMandateOutput: () => Buffer.alloc(32),
		addressToBytes32: (a: string) => ("0x" + a.slice(2).padStart(64, "0")) as `0x${string}`,
		bytes32ToAddress: (b: string) => ("0x" + b.slice(-40)) as `0x${string}`,
		orderToIntent: () => ({})
	}));

	mock.module("$lib/state.svelte", () => ({
		default: {
			getTransactionReceipt: () => null,
			saveTransactionReceipt: async () => {}
		}
	}));

	mock.module("$lib/abi/outputsettler", () => ({ COIN_FILLER_ABI: [] }));
	mock.module("$lib/abi/polymeroracle", () => ({ POLYMER_ORACLE_ABI: [] }));
	mock.module("$lib/abi/escrow", () => ({ SETTLER_ESCROW_ABI: [] }));
	mock.module("$lib/abi/compact", () => ({ COMPACT_ABI: [] }));
	// @solana/web3.js is NOT mocked — flowProgress only needs `new PublicKey(pda)`
	// which is passed directly to our mocked getAccountInfo (queue-based, no key inspection).
});

// ---------------------------------------------------------------------------
// Tests: isOutputValidatedOnChain Solana branch (attestation PDA check)
// ---------------------------------------------------------------------------

describe("flowProgress — isOutputValidatedOnChain Solana branch (attestation PDA)", () => {
	it("allValidated=true when attestation PDA account exists", async () => {
		// 1st call: attestation PDA → exists; 2nd call: order_context PDA → also exists
		accountInfoQueue.push({ data: Buffer.alloc(0) }, { data: Buffer.alloc(0) });

		const { getOrderProgressChecks } = await import("../../src/lib/libraries/flowProgress");
		const result = await getOrderProgressChecks(fakeContainer, {
			[FAKE_ORDER_ID]: FAKE_TX_HASH
		});

		expect(result.allValidated).toBe(true);
	});

	it("allValidated=false when attestation PDA is absent (null)", async () => {
		// 1st call: attestation PDA → null (no proof); order_context not checked (validated=false)
		accountInfoQueue.push(null);

		const { getOrderProgressChecks } = await import("../../src/lib/libraries/flowProgress");
		const result = await getOrderProgressChecks(fakeContainer, {
			[FAKE_ORDER_ID]: FAKE_TX_HASH
		});

		expect(result.allValidated).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: isInputChainFinalised Solana branch (order_context PDA check)
// ---------------------------------------------------------------------------

describe("flowProgress — isInputChainFinalised Solana branch (order_context PDA)", () => {
	it("allFinalised=true when order_context PDA is closed (null)", async () => {
		// 1st call: attestation PDA → exists (validated=true)
		// 2nd call: order_context PDA → null (closed = finalised)
		accountInfoQueue.push({ data: Buffer.alloc(0) }, null);

		const { getOrderProgressChecks } = await import("../../src/lib/libraries/flowProgress");
		const result = await getOrderProgressChecks(fakeContainer, {
			[FAKE_ORDER_ID]: FAKE_TX_HASH
		});

		expect(result.allFinalised).toBe(true);
	});

	it("allFinalised=false when order_context PDA still exists", async () => {
		// 1st call: attestation PDA → exists (validated=true)
		// 2nd call: order_context PDA → exists (not finalised)
		accountInfoQueue.push({ data: Buffer.alloc(0) }, { data: Buffer.alloc(0) });

		const { getOrderProgressChecks } = await import("../../src/lib/libraries/flowProgress");
		const result = await getOrderProgressChecks(fakeContainer, {
			[FAKE_ORDER_ID]: FAKE_TX_HASH
		});

		expect(result.allFinalised).toBe(false);
	});
});
