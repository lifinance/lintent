import { describe, expect, it, mock, beforeEach, afterAll } from "bun:test";
import type { StandardSolana } from "@lifi/intent";

// ---------------------------------------------------------------------------
// Minimal fixture
// ---------------------------------------------------------------------------

const SOLANA_PUBKEY = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
// SPL mint as 32-byte bigint (USDC devnet: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU)
const USDC_MINT_BIGINT = 0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7n;

function makeOrder(overrides: Partial<StandardSolana> = {}): StandardSolana {
	const now = Math.floor(Date.now() / 1000);
	return {
		user: ("0x" + "11".repeat(32)) as `0x${string}`,
		nonce: 1n,
		originChainId: 1151111081099712n, // Solana devnet
		expires: now + 600,
		fillDeadline: now + 599,
		inputOracle: ("0x" + "aa".repeat(32)) as `0x${string}`,
		inputs: [[USDC_MINT_BIGINT, 1_000_000n]],
		outputs: [
			{
				oracle: ("0x" + "bb".repeat(32)) as `0x${string}`,
				settler: ("0x" + "cc".repeat(32)) as `0x${string}`,
				chainId: 11155111n,
				token: ("0x" + "dd".repeat(32)) as `0x${string}`,
				amount: 990_000n,
				recipient: ("0x" + "ee".repeat(32)) as `0x${string}`,
				callbackData: "0x",
				context: "0x"
			}
		],
		...overrides
	};
}

// ---------------------------------------------------------------------------
// Mock heavy Solana/Anchor dependencies before importing the module under test.
// We mock only @coral-xyz/anchor and @solana/spl-token — NOT @solana/web3.js
// directly, to avoid leaking into solanaUtils.test.ts which uses the real module.
// ---------------------------------------------------------------------------

const mockRpc = mock(async () => "mock-signature-abc123");
const mockAccounts = mock(() => ({ rpc: mockRpc }));
const mockOpen = mock(() => ({ accounts: mockAccounts }));
const mockEncode = mock(() => new Uint8Array(32));

mock.module("@coral-xyz/anchor", () => ({
	AnchorProvider: class {
		constructor() {}
	},
	BN: class {
		constructor(public v: string) {}
		toString() {
			return this.v;
		}
	},
	Program: class {
		methods = { open: mockOpen };
		coder = { types: { encode: mockEncode } };
		constructor() {}
	}
}));

mock.module("@solana/spl-token", () => ({
	ASSOCIATED_TOKEN_PROGRAM_ID: "mockAtaProgramId",
	TOKEN_PROGRAM_ID: "mockTokenProgramId",
	getAssociatedTokenAddressSync: mock(() => "mockAta")
}));

// Config constants used inside the module
mock.module("$lib/config", () => ({
	SOLANA_INPUT_SETTLER_ESCROW: "5QngyaYhNscSebqV4DwYQhk333p5CMP8A9yyLX3pPyXC",
	SOLANA_POLYMER_ORACLE: "C2rAFLS6xQ78t18rK5s9madY9fztbhTaHwShgYtzonk7"
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("openSolanaEscrow", () => {
	const walletAdapter = {
		signTransaction: mock(async (tx: any) => tx),
		signAllTransactions: mock(async (txs: any[]) => txs)
	} as any;
	const connection = {} as any;

	beforeEach(() => {
		mockRpc.mockClear();
		mockEncode.mockClear();
	});

	afterAll(() => {
		mock.restore();
	});

	it("throws immediately when order.inputs is empty", async () => {
		const { openSolanaEscrow } = await import("../../src/lib/libraries/solanaEscrowLib");
		const order = makeOrder({ inputs: [] as any });
		await expect(
			openSolanaEscrow({ order, solanaPublicKey: SOLANA_PUBKEY, walletAdapter, connection })
		).rejects.toThrow("StandardSolana order has no inputs");
	});

	it("returns the transaction signature on the happy path", async () => {
		const { openSolanaEscrow } = await import("../../src/lib/libraries/solanaEscrowLib");
		const result = await openSolanaEscrow({
			order: makeOrder(),
			solanaPublicKey: SOLANA_PUBKEY,
			walletAdapter,
			connection
		});
		expect(result).toBe("mock-signature-abc123");
	});

	it("wraps Borsh encode errors with context", async () => {
		mockEncode.mockImplementationOnce(() => {
			throw new Error("unknown type key");
		});
		const { openSolanaEscrow } = await import("../../src/lib/libraries/solanaEscrowLib");
		await expect(
			openSolanaEscrow({
				order: makeOrder(),
				solanaPublicKey: SOLANA_PUBKEY,
				walletAdapter,
				connection
			})
		).rejects.toThrow("Borsh encoding failed for standardOrder: unknown type key");
	});

	it("rejects with a timeout error when the RPC call hangs", async () => {
		// Make .rpc() hang forever
		mockRpc.mockImplementationOnce(() => new Promise(() => {}));

		// Patch the timeout to 50 ms so the test doesn't wait 60 s
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, _ms: number) => {
			return realSetTimeout(fn, 50);
		}) as any;

		const { openSolanaEscrow } = await import("../../src/lib/libraries/solanaEscrowLib");
		await expect(
			openSolanaEscrow({
				order: makeOrder(),
				solanaPublicKey: SOLANA_PUBKEY,
				walletAdapter,
				connection
			})
		).rejects.toThrow("timed out");

		globalThis.setTimeout = realSetTimeout;
	});
});
