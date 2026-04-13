import { describe, expect, it, mock, beforeAll } from "bun:test";
import type { MandateOutput, StandardSolana } from "@lifi/intent";
import type { SignerWalletAdapter } from "@solana/wallet-adapter-base";
import type { Connection } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEVNET_CHAIN_ID = 1151111081099712n;
const FAKE_ORACLE = ("0x" + "ab".repeat(32)) as `0x${string}`;
const FAKE_SETTLER = ("0x" + "cd".repeat(32)) as `0x${string}`;
const FAKE_TOKEN = ("0x" + "ef".repeat(32)) as `0x${string}`;
const FAKE_RECIPIENT = ("0x" + "12".repeat(32)) as `0x${string}`;

const fakeOutput: MandateOutput = {
	oracle: FAKE_ORACLE,
	settler: FAKE_SETTLER,
	chainId: 84532n,
	token: FAKE_TOKEN,
	amount: 1_000_000n,
	recipient: FAKE_RECIPIENT,
	callbackData: "0x",
	context: "0x"
};

function makeOrder(inputs: [bigint, bigint][]): StandardSolana {
	return {
		user: ("0x" + "aa".repeat(20)) as `0x${string}`,
		nonce: 1n,
		originChainId: DEVNET_CHAIN_ID,
		expires: Math.floor(Date.now() / 1000) + 3600,
		fillDeadline: Math.floor(Date.now() / 1000) + 3599,
		inputOracle: ("0x" + "bb".repeat(20)) as `0x${string}`,
		// Cast required: StandardSolana mandates exactly one input; we test zero below
		inputs: inputs as unknown as [[bigint, bigint]],
		outputs: [fakeOutput]
	};
}

/** Minimal Connection mock — not exercised by the empty-inputs guard */
function makeConnection(): Connection {
	return {
		getLatestBlockhash: mock(async () => ({ blockhash: "abc", lastValidBlockHeight: 999 })),
		sendRawTransaction: mock(async () => "fakeSig"),
		confirmTransaction: mock(async () => ({ value: { err: null } }))
	} as unknown as Connection;
}

/** Minimal wallet adapter mock */
function makeAdapter(): SignerWalletAdapter {
	return {
		signTransaction: mock(async (tx: unknown) => tx),
		signAllTransactions: mock(async (txs: unknown[]) => txs)
	} as unknown as SignerWalletAdapter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("openSolanaEscrow", () => {
	it("throws immediately when order.inputs is empty", async () => {
		const { openSolanaEscrow } = await import("../../src/lib/libraries/solanaEscrowLib");

		const order = makeOrder([]);
		await expect(
			openSolanaEscrow({
				order,
				solanaPublicKey: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQH7x",
				walletAdapter: makeAdapter(),
				connection: makeConnection()
			})
		).rejects.toThrow("StandardSolana order has no inputs");
	});

	it("wraps Borsh encoding errors with a descriptive message", async () => {
		// Mock @coral-xyz/anchor so Program.coder.types.encode throws
		mock.module("@coral-xyz/anchor", () => {
			class FakePublicKey {
				constructor(public key: unknown) {}
				static findProgramAddressSync() {
					return [new FakePublicKey("pda"), 255];
				}
			}
			class FakeBN {
				constructor(public n: string) {}
				toString() {
					return this.n;
				}
			}
			class FakeProgram {
				get coder() {
					return {
						types: {
							encode(_name: string, _data: unknown): never {
								throw new Error("IDL type not found: standardOrder");
							}
						}
					};
				}
				get methods() {
					return new Proxy(
						{},
						{
							get: () => () => ({
								accounts: () => ({
									transaction: async () => ({ feePayer: null, recentBlockhash: null })
								})
							})
						}
					);
				}
			}
			class FakeAnchorProvider {
				constructor(
					public conn: unknown,
					public wallet: unknown,
					public opts: unknown
				) {}
			}
			return {
				AnchorProvider: FakeAnchorProvider,
				BN: FakeBN,
				Program: FakeProgram
			};
		});

		mock.module("@solana/web3.js", () => {
			class FakePublicKey {
				constructor(public key: unknown) {}
				toBase58() {
					return String(this.key);
				}
				toBuffer() {
					return Buffer.alloc(32);
				}
				equals(other: FakePublicKey) {
					return this.key === other.key;
				}
				static findProgramAddressSync() {
					return [new FakePublicKey("pda"), 255];
				}
			}
			const SystemProgram = { programId: new FakePublicKey("system") };
			return { PublicKey: FakePublicKey, SystemProgram };
		});

		mock.module("@solana/spl-token", () => ({
			ASSOCIATED_TOKEN_PROGRAM_ID: "assocProg",
			TOKEN_PROGRAM_ID: "tokenProg",
			getAssociatedTokenAddressSync: () => "ataAddr"
		}));

		const { openSolanaEscrow } = await import("../../src/lib/libraries/solanaEscrowLib");

		// 32-byte token ID as bigint (Solana SPL mint)
		const mintBigint = BigInt(
			"0x" + "3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7"
		);
		const order = makeOrder([[mintBigint, 100_000n]]);

		await expect(
			openSolanaEscrow({
				order,
				solanaPublicKey: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQH7x",
				walletAdapter: makeAdapter(),
				connection: makeConnection()
			})
		).rejects.toThrow("Borsh encoding failed for standardOrder");
	});
});
