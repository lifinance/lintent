import { json } from "@sveltejs/kit";
import { VOW_ORACLE } from "$lib/config";

export async function proxyVowWitness(
  request: Request,
  fetchWitness: typeof fetch,
  config: { endpoint?: string; apiKey?: string; signerIndex?: string }
): Promise<Response> {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { chainId, blockNumber, logIndex } = body ?? {};
  if (
    !Number.isSafeInteger(chainId) ||
    !VOW_ORACLE[chainId] ||
    !/^(0|[1-9][0-9]*)$/.test(String(blockNumber)) ||
    !Number.isSafeInteger(Number(blockNumber)) ||
    !Number.isSafeInteger(logIndex) ||
    logIndex < 0
  ) {
    return json(
      { error: "Expected a supported Vow EVM chain, block number, and global log index" },
      { status: 400 }
    );
  }
  const signerIndex = Number(config.signerIndex ?? "1");
  if (!Number.isInteger(signerIndex) || signerIndex < 1 || signerIndex > 255) {
    return json({ error: "Invalid Vow signer index configuration" }, { status: 500 });
  }
  try {
    const url = new URL(
      `/witness/eip155:${chainId}/${blockNumber}/${logIndex}`,
      config.endpoint ?? "https://witness.vav.me"
    );
    const response = await fetchWitness(url, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      signal: AbortSignal.timeout(12_000)
    });
    if (response.status === 429 || response.status >= 500) {
      return json({ status: "pending" }, { status: response.status === 429 ? 429 : 503 });
    }
    if (!response.ok) {
      return json(
        { error: `Vow witness request rejected (HTTP ${response.status})` },
        { status: response.status }
      );
    }
    const payload = await response.json();
    return json({ ...payload, signerIndex }, { headers: { "cache-control": "no-store" } });
  } catch {
    return json({ status: "pending" }, { status: 503 });
  }
}
