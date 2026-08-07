export type OrderExpiry = {
  /** Unix seconds from `order.expires`. */
  expiresAt: number;
  secondsRemaining: number;
  expired: boolean;
  /** Human "1h 04m" / "expired 12m ago" text. */
  label: string;
};

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${String(hours).padStart(2, "0")}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

/**
 * Time left on `order.expires`, which is the deadline the relayer is racing: once it
 * passes, ANYONE can refund the user's inputs, while the solver has already paid the
 * output irreversibly — and `finalise` then reverts. Purely informational; the app does
 * not block on it.
 */
export function getOrderExpiry(expires: number | bigint, nowMs: number = Date.now()): OrderExpiry {
  const expiresAt = Number(expires);
  const secondsRemaining = expiresAt - Math.floor(nowMs / 1000);
  const expired = secondsRemaining <= 0;
  return {
    expiresAt,
    secondsRemaining,
    expired,
    label: expired
      ? `expired ${formatDuration(-secondsRemaining)} ago`
      : formatDuration(secondsRemaining)
  };
}
