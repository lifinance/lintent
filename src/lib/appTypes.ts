import type { Token, Verifier } from "./config";
import type { CreateIntentOptions } from "@lifi/intent";

export type AppTokenContext = {
  token: Token;
  amount: bigint;
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
