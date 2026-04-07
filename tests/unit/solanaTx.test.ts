import { describe, expect, it, mock } from "bun:test";
import { sendAndConfirmSolanaTx } from "../../src/lib/utils/solanaTx";
import type { Connection } from "@solana/web3.js";

const FAKE_BLOCKHASH = { blockhash: "fakeBlockhash", lastValidBlockHeight: 9999 };
const FAKE_SIG = "fakeSig123";
const RAW_TX = new Uint8Array([1, 2, 3]);

const OK = { value: { err: null } };
const PROGRAM_ERR = { value: { err: { InstructionError: [0, "InvalidArgument"] } } };

/** Resolves after `ms` milliseconds with `value`. */
const delay = <T>(ms: number, value: T) =>
	new Promise<T>((res) => setTimeout(() => res(value), ms));

/** Builds a minimal Connection mock. Each field can be overridden. */
function makeConnection(overrides: Partial<Record<string, unknown>> = {}): Connection {
	return {
		getLatestBlockhash: mock(async () => FAKE_BLOCKHASH),
		sendRawTransaction: mock(async () => FAKE_SIG),
		confirmTransaction: mock(async () => OK),
		...overrides
	} as unknown as Connection;
}

describe("sendAndConfirmSolanaTx", () => {
	it("returns the signature when confirmation succeeds on the first attempt", async () => {
		const conn = makeConnection();

		const sig = await sendAndConfirmSolanaTx(conn, RAW_TX);

		expect(sig).toBe(FAKE_SIG);
		expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
		expect(conn.confirmTransaction).toHaveBeenCalledTimes(1);
	});

	it("retries once when the first confirmation times out, succeeds on retry", async () => {
		let call = 0;
		const confirmTransaction = mock(async () => {
			// First call: slow (misses 1 ms timeout). Second call: immediate.
			return call++ === 0 ? delay(50, OK) : OK;
		});
		const conn = makeConnection({ confirmTransaction });

		const sig = await sendAndConfirmSolanaTx(conn, RAW_TX, { confirmTimeoutMs: 1 });

		expect(sig).toBe(FAKE_SIG);
		expect(conn.sendRawTransaction).toHaveBeenCalledTimes(2);
		expect(conn.confirmTransaction).toHaveBeenCalledTimes(2);
	});

	it("throws after all retries are exhausted", async () => {
		// Both calls are slow — neither confirms within the timeout.
		const confirmTransaction = mock(() => delay(50, OK));
		const conn = makeConnection({ confirmTransaction });

		await expect(sendAndConfirmSolanaTx(conn, RAW_TX, { confirmTimeoutMs: 1 })).rejects.toThrow(
			"Confirmation timed out after"
		);

		expect(conn.sendRawTransaction).toHaveBeenCalledTimes(2); // initial + 1 retry
	});

	it("throws immediately on a program error without retrying", async () => {
		const confirmTransaction = mock(async () => PROGRAM_ERR);
		const conn = makeConnection({ confirmTransaction });

		await expect(sendAndConfirmSolanaTx(conn, RAW_TX)).rejects.toThrow("Transaction failed");

		expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
	});

	it("throws immediately on an RPC error without retrying", async () => {
		const confirmTransaction = mock(async () => {
			throw new Error("RPC node unreachable");
		});
		const conn = makeConnection({ confirmTransaction });

		await expect(sendAndConfirmSolanaTx(conn, RAW_TX)).rejects.toThrow("RPC node unreachable");

		expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
	});

	it("passes the serialized transaction bytes to sendRawTransaction", async () => {
		const conn = makeConnection();

		await sendAndConfirmSolanaTx(conn, RAW_TX);

		expect(conn.sendRawTransaction).toHaveBeenCalledWith(RAW_TX, expect.anything());
	});

	it("passes signature + blockhash anchor to confirmTransaction", async () => {
		const conn = makeConnection();

		await sendAndConfirmSolanaTx(conn, RAW_TX);

		expect(conn.confirmTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				signature: FAKE_SIG,
				blockhash: FAKE_BLOCKHASH.blockhash,
				lastValidBlockHeight: FAKE_BLOCKHASH.lastValidBlockHeight
			}),
			"confirmed"
		);
	});

	it("fetches a fresh blockhash for each attempt", async () => {
		let call = 0;
		const confirmTransaction = mock(async () => (call++ === 0 ? delay(50, OK) : OK));
		const conn = makeConnection({ confirmTransaction });

		await sendAndConfirmSolanaTx(conn, RAW_TX, { confirmTimeoutMs: 1 });

		expect(conn.getLatestBlockhash).toHaveBeenCalledTimes(2);
	});

	it("respects a custom maxRetries of 0 (no retry)", async () => {
		const confirmTransaction = mock(() => delay(50, OK));
		const conn = makeConnection({ confirmTransaction });

		await expect(
			sendAndConfirmSolanaTx(conn, RAW_TX, { confirmTimeoutMs: 1, maxRetries: 0 })
		).rejects.toThrow("Confirmation timed out after");

		expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
	});
});
