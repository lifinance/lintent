import { describe, expect, it } from "bun:test";
import type { MandateOutput } from "@lifi/intent";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_SEPOLIA_CHAIN_ID = 84532n;
const DEVNET_CHAIN_ID = 1151111081099712n;

const FAKE_ORACLE = ("0x" + "ab".repeat(32)) as `0x${string}`;
const FAKE_SETTLER = ("0x" + "cd".repeat(32)) as `0x${string}`;
const FAKE_TOKEN = ("0x" + "ef".repeat(32)) as `0x${string}`;
const FAKE_RECIPIENT = ("0x" + "12".repeat(32)) as `0x${string}`;
const FAKE_SOLVER = ("0x" + "aa".repeat(32)) as `0x${string}`;
const FAKE_ORDER_ID = ("0x" + "bb".repeat(32)) as `0x${string}`;

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

// ---------------------------------------------------------------------------
// encodeCommonPayload / encodeFillDescription (pure functions, no mocking)
// ---------------------------------------------------------------------------

describe("encodeCommonPayload", () => {
	it("encodes a basic output to a Buffer", async () => {
		const { encodeCommonPayload } = await import("../../src/lib/libraries/solanaValidateLib");
		const buf = encodeCommonPayload(fakeOutput);
		expect(buf).toBeInstanceOf(Buffer);
		// token(32) + amount(32) + recipient(32) + callLen(2) + ctxLen(2) = 100 bytes minimum
		expect(buf.length).toBeGreaterThanOrEqual(100);
	});

	it("produces different output for different amounts", async () => {
		const { encodeCommonPayload } = await import("../../src/lib/libraries/solanaValidateLib");
		const buf1 = encodeCommonPayload(fakeOutput);
		const buf2 = encodeCommonPayload({ ...fakeOutput, amount: 2_000_000n });
		expect(buf1.toString("hex")).not.toBe(buf2.toString("hex"));
	});

	it("includes non-empty callbackData length in the encoding", async () => {
		const { encodeCommonPayload } = await import("../../src/lib/libraries/solanaValidateLib");
		const withCallback = encodeCommonPayload({ ...fakeOutput, callbackData: "0xdeadbeef" });
		const withoutCallback = encodeCommonPayload(fakeOutput);
		// 4 extra bytes (0xdeadbeef) means the buffer with callback is longer
		expect(withCallback.length).toBe(withoutCallback.length + 4);
	});
});

describe("encodeFillDescription", () => {
	it("is solver(32) || orderId(32) || timestamp(4BE) || commonPayload", async () => {
		const { encodeCommonPayload, encodeFillDescription } = await import(
			"../../src/lib/libraries/solanaValidateLib"
		);
		const common = encodeCommonPayload(fakeOutput);
		const desc = encodeFillDescription(FAKE_SOLVER, FAKE_ORDER_ID, 1_700_000_000, common);

		// First 32 bytes = solver
		expect(desc.subarray(0, 32).toString("hex")).toBe(FAKE_SOLVER.slice(2));
		// Next 32 bytes = orderId
		expect(desc.subarray(32, 64).toString("hex")).toBe(FAKE_ORDER_ID.slice(2));
		// Next 4 bytes = timestamp big-endian
		const ts = desc.readUInt32BE(64);
		expect(ts).toBe(1_700_000_000);
		// Remainder = commonPayload
		expect(desc.subarray(68).toString("hex")).toBe(common.toString("hex"));
	});

	it("changes output when solver changes", async () => {
		const { encodeCommonPayload, encodeFillDescription } = await import(
			"../../src/lib/libraries/solanaValidateLib"
		);
		const common = encodeCommonPayload(fakeOutput);
		const otherSolver = ("0x" + "cc".repeat(32)) as `0x${string}`;
		const d1 = encodeFillDescription(FAKE_SOLVER, FAKE_ORDER_ID, 1000, common);
		const d2 = encodeFillDescription(otherSolver, FAKE_ORDER_ID, 1000, common);
		expect(d1.toString("hex")).not.toBe(d2.toString("hex"));
	});

	// Payload-level uniqueness for the three parameters that flow through payloadHash
	// into the attestation PDA seed (fillTimestamp, orderId, solver → encodeFillDescription).

	it("payloadHash differs when fillTimestamp changes", async () => {
		const { keccak256 } = await import("viem");
		const { encodeCommonPayload, encodeFillDescription } = await import(
			"../../src/lib/libraries/solanaValidateLib"
		);
		const common = encodeCommonPayload(fakeOutput);
		const d1 = encodeFillDescription(FAKE_SOLVER, FAKE_ORDER_ID, 1_700_000_000, common);
		const d2 = encodeFillDescription(FAKE_SOLVER, FAKE_ORDER_ID, 1_700_000_001, common);
		expect(keccak256(d1)).not.toBe(keccak256(d2));
	});

	it("payloadHash differs when orderId changes", async () => {
		const { keccak256 } = await import("viem");
		const { encodeCommonPayload, encodeFillDescription } = await import(
			"../../src/lib/libraries/solanaValidateLib"
		);
		const common = encodeCommonPayload(fakeOutput);
		const otherId = ("0x" + "cc".repeat(32)) as `0x${string}`;
		const d1 = encodeFillDescription(FAKE_SOLVER, FAKE_ORDER_ID, 1_700_000_000, common);
		const d2 = encodeFillDescription(FAKE_SOLVER, otherId, 1_700_000_000, common);
		expect(keccak256(d1)).not.toBe(keccak256(d2));
	});

	it("payloadHash differs when solverBytes32 changes", async () => {
		const { keccak256 } = await import("viem");
		const { encodeCommonPayload, encodeFillDescription } = await import(
			"../../src/lib/libraries/solanaValidateLib"
		);
		const common = encodeCommonPayload(fakeOutput);
		const otherSolver = ("0x" + "dd".repeat(32)) as `0x${string}`;
		const d1 = encodeFillDescription(FAKE_SOLVER, FAKE_ORDER_ID, 1_700_000_000, common);
		const d2 = encodeFillDescription(otherSolver, FAKE_ORDER_ID, 1_700_000_000, common);
		expect(keccak256(d1)).not.toBe(keccak256(d2));
	});
});

// ---------------------------------------------------------------------------
// deriveAttestationPda — uses real @solana/web3.js PDA derivation (no network)
// ---------------------------------------------------------------------------

describe("deriveAttestationPda", () => {
	const baseParams = {
		evmChainId: BASE_SEPOLIA_CHAIN_ID,
		output: fakeOutput,
		orderId: FAKE_ORDER_ID,
		fillTimestamp: 1_700_000_000,
		solverBytes32: FAKE_SOLVER
	};

	it("returns a non-empty base58 string", async () => {
		const { deriveAttestationPda } = await import("../../src/lib/libraries/solanaValidateLib");
		const pda = await deriveAttestationPda(baseParams);
		expect(typeof pda).toBe("string");
		expect(pda.length).toBeGreaterThan(0);
		// Base58 characters only
		expect(pda).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
	});

	it("is deterministic — same inputs produce the same PDA", async () => {
		const { deriveAttestationPda } = await import("../../src/lib/libraries/solanaValidateLib");
		const pda1 = await deriveAttestationPda(baseParams);
		const pda2 = await deriveAttestationPda(baseParams);
		expect(pda1).toBe(pda2);
	});

	// The PDA's uniqueness derives from the payloadHash = keccak256(encodeFillDescription(...)).
	// The "changes when X changes" property is verified at the payload level below, where no
	// real findProgramAddressSync is needed. evmChainId and emittingContract are PDA seeds
	// (not part of the payload) — their uniqueness is guaranteed by Solana's PDA spec.
});

// ---------------------------------------------------------------------------
// deriveOrderContextPda — uses real @solana/web3.js PDA derivation (no network)
// ---------------------------------------------------------------------------

describe("deriveOrderContextPda", () => {
	const MINT_BIGINT = BigInt("0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7");

	function makeOrder(nonce = 1n) {
		return {
			user: ("0x" + "aa".repeat(20)) as `0x${string}`,
			nonce,
			originChainId: DEVNET_CHAIN_ID,
			expires: 2000000000,
			fillDeadline: 1999999999,
			inputOracle: ("0x" + "bb".repeat(20)) as `0x${string}`,
			inputs: [[MINT_BIGINT, 1_000_000n]] as [[bigint, bigint]],
			outputs: [fakeOutput]
		};
	}

	it("returns a non-empty base58 string", async () => {
		const { deriveOrderContextPda } = await import("../../src/lib/libraries/solanaFinaliseLib");
		const pda = await deriveOrderContextPda(makeOrder());
		expect(typeof pda).toBe("string");
		expect(pda.length).toBeGreaterThan(0);
		expect(pda).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
	});

	it("is deterministic — same order produces the same PDA", async () => {
		const { deriveOrderContextPda } = await import("../../src/lib/libraries/solanaFinaliseLib");
		const order = makeOrder();
		const pda1 = await deriveOrderContextPda(order);
		const pda2 = await deriveOrderContextPda(order);
		expect(pda1).toBe(pda2);
	});

	it("orderId (borsh hash) differs when nonce changes", async () => {
		// The order_context PDA seed is orderId = keccak256(borshEncodeSolanaOrder(order)).
		// Verify that different nonces → different orderId, which → different PDA seed.
		const { keccak256 } = await import("viem");
		const { borshEncodeSolanaOrder } = await import("@lifi/intent");
		const id1 = keccak256(borshEncodeSolanaOrder(makeOrder(1n)));
		const id2 = keccak256(borshEncodeSolanaOrder(makeOrder(2n)));
		expect(id1).not.toBe(id2);
	});
});
