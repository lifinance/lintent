import { describe, expect, it } from "bun:test";
import { proxyVowWitness } from "../../src/lib/server/vowWitness";

function request(body: unknown) {
  return new Request("https://lintent.test/vow", { method: "POST", body: JSON.stringify(body) });
}
const body = { chainId: 8453, blockNumber: "100", logIndex: 0 };

describe("Vow proxy", () => {
  it("uses a fixed upstream path and a private bearer key", async () => {
    let calledUrl = "";
    let auth: string | null = null;
    const fakeFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        calledUrl = String(input);
        auth = new Headers(init?.headers).get("Authorization");
        return Response.json({ status: "pending" });
      },
      { preconnect: fetch.preconnect }
    );
    const response = await proxyVowWitness(request(body), fakeFetch, {
      apiKey: "private-test-key"
    });
    expect(calledUrl).toBe("https://witness.vav.me/witness/eip155:8453/100/0");
    expect(auth as string | null).toBe("Bearer private-test-key");
    expect(await response.json()).toEqual({ status: "pending", signerIndex: 1 });
  });
  it("rejects unsupported chains and malformed indices without fetching", async () => {
    const fakeFetch = Object.assign(
      async () => {
        throw new Error("must not fetch");
      },
      { preconnect: fetch.preconnect }
    );
    for (const invalid of [
      null,
      { ...body, chainId: 728126428 },
      { ...body, chainId: 5042002 },
      { ...body, logIndex: -1 },
      { ...body, logIndex: 1.5 },
      { ...body, blockNumber: "../" }
    ]) {
      expect((await proxyVowWitness(request(invalid), fakeFetch, {})).status).toBe(400);
    }
  });
  it("preserves retryable and permanent HTTP failures", async () => {
    for (const status of [401, 404, 429, 500, 503]) {
      const fakeFetch = Object.assign(async () => new Response(null, { status }), {
        preconnect: fetch.preconnect
      });
      const response = await proxyVowWitness(request(body), fakeFetch, {});
      expect(response.status).toBe(status >= 500 ? 503 : status);
    }
  });
  it("forwards ready payloads with the configured signer index", async () => {
    const fakeFetch = Object.assign(
      async () => Response.json({ status: "ready", witness: { root: "0x123" } }),
      { preconnect: fetch.preconnect }
    );
    const response = await proxyVowWitness(request(body), fakeFetch, { signerIndex: "2" });
    expect(await response.json()).toEqual({
      status: "ready",
      witness: { root: "0x123" },
      signerIndex: 2
    });
    expect((await proxyVowWitness(request(body), fakeFetch, { signerIndex: "0" })).status).toBe(
      500
    );
  });
});
