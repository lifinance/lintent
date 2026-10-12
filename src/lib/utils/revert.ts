/**
 * Human-readable reason for a failed contract call: the decoded custom error
 * name (with args) when viem decoded one, else the error message.
 */
export function extractRevertReason(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "cause" in error &&
    error.cause &&
    typeof error.cause === "object" &&
    "data" in error.cause
  ) {
    const reverted = error.cause as { data?: { errorName?: string; args?: unknown[] } };
    if (reverted.data?.errorName) {
      const args = reverted.data.args?.length ? ` (${reverted.data.args.join(", ")})` : "";
      return `${reverted.data.errorName}${args}`;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
