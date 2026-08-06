import { beforeAll, describe, expect, it, mock } from "bun:test";
import { EXPECTED_TOPIC0 } from "../../src/lib/libraries/provableEvents";

// `$env/static/private` is a Vite virtual module with no file behind it, so the real one can
// never resolve under `bun test`. Stub it before importing the module under test.
mock.module("$env/static/private", () => ({ PRIVATE_ROUTEMESH_API_KEY: "test-key" }));

type RpcCall = { method: string; params: unknown[] };

let verifyProvableLog: typeof import("../../src/lib/libraries/provableLogVerify").verifyProvableLog;
const calls: RpcCall[] = [];
let reply: (call: RpcCall) => unknown;

beforeAll(async () => {
	// viem's http transport goes through fetch; intercepting there keeps the assertion on the
	// literal JSON-RPC body, which is the thing that actually has to be right.
	global.fetch = (async (_url: string, init?: RequestInit) => {
		const call = JSON.parse(String(init?.body)) as RpcCall;
		calls.push(call);
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: reply(call) }), {
			status: 200,
			headers: { "content-type": "application/json" }
		});
	}) as unknown as typeof fetch;

	({ verifyProvableLog } = await import("../../src/lib/libraries/provableLogVerify"));
});

/** A minimal eth_getLogs result shaped enough for viem to format it. */
function log(logIndex: number, topic0: `0x${string}`) {
	return {
		address: "0x75220b7600c300005038432a0000f308e0000068",
		topics: [topic0, `0x${"11".repeat(32)}`],
		data: "0x",
		blockNumber: "0x64",
		blockHash: `0x${"22".repeat(32)}`,
		transactionHash: `0x${"33".repeat(32)}`,
		transactionIndex: "0x0",
		logIndex: `0x${logIndex.toString(16)}`,
		removed: false
	};
}

describe("verifyProvableLog", () => {
	it("asks the RPC for BOTH topics as an OR set", async () => {
		// The whole point of the change. viem collapses the singular `event` option into a flat
		// `topics: [topic0]`, so a revert to it would still satisfy every ABI-level test — only
		// this assertion on the wire format catches it.
		calls.length = 0;
		reply = () => [];
		await verifyProvableLog(8453, 100n, 3);

		const getLogs = calls.find((c) => c.method === "eth_getLogs");
		expect(getLogs).toBeDefined();
		expect((getLogs?.params[0] as { topics: unknown }).topics).toEqual([
			[EXPECTED_TOPIC0.OutputFilled, EXPECTED_TOPIC0.OutputNotFilled]
		]);
	});

	it("matches an OutputNotFilled log at the requested index", async () => {
		calls.length = 0;
		reply = () => [log(3, EXPECTED_TOPIC0.OutputNotFilled)];
		expect(await verifyProvableLog(8453, 100n, 3)).toBe("match");
	});

	it("still matches an OutputFilled log at the requested index", async () => {
		calls.length = 0;
		reply = () => [log(7, EXPECTED_TOPIC0.OutputFilled)];
		expect(await verifyProvableLog(8453, 100n, 7)).toBe("match");
	});

	it("rejects when no allowlisted log sits at the requested index", async () => {
		// The gate's actual job: the block has a provable log, but not the one being pointed at.
		calls.length = 0;
		reply = () => [log(3, EXPECTED_TOPIC0.OutputNotFilled)];
		expect(await verifyProvableLog(8453, 100n, 4)).toBe("mismatch");
	});

	it("degrades to unknown when the RPC fails, rather than throwing", async () => {
		// Deliberately fail-open (the route only rejects "mismatch"), so an infra blip does not
		// block the happy path. Pinned so the trade-off is a decision, not an accident.
		calls.length = 0;
		reply = () => {
			throw new Error("rpc down");
		};
		expect(await verifyProvableLog(8453, 100n, 3)).toBe("unknown");
	});
});
