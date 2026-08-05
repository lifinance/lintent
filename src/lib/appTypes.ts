import type { Token, Verifier } from "./config";
import type { CreateIntentOptions, OrderContainer } from "@lifi/intent";

export type AppTokenContext = {
  token: Token;
  amount: bigint;
};

/**
 * An order container plus the app-local metadata persisted next to it in the
 * `intents` table. `@lifi/intent`'s `OrderContainer` carries none of these:
 * `id`/`intentType`/`createdAt` mirror table columns, and `submitTime` is the
 * order-server submit time when the order server reported one.
 */
export type OrderContainerWithMeta = OrderContainer & {
  id?: string;
  intentType?: string;
  createdAt?: number;
  submitTime?: number;
};

export type AppCreateIntentOptions = Omit<
  CreateIntentOptions,
  "account" | "inputTokens" | "outputTokens"
> & {
  inputTokens: AppTokenContext[];
  outputTokens: AppTokenContext[];
  verifier: Verifier;
  account: () => `0x${string}`;
};
