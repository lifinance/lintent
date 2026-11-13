/**
 * POSTs `body` as JSON and returns the parsed JSON reply; throws on a non-2xx status.
 *
 * Plain `fetch` so server routes run unchanged on Cloudflare Workers: workerd rejects request
 * options a browser accepts (axios >=1.20 sends `cache: "default"` and fails with "Unsupported
 * cache mode"), so do not reintroduce an HTTP client here without testing it under workerd.
 */
export async function postJson<T>(
  url: string,
  body: unknown,
  options: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...options.headers },
    body: JSON.stringify(body),
    signal: options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}
