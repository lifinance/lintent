// EVM-specific app types
export type EvmChain = {
  id: number;
  name: string;
  displayName: string;
  testnet: boolean;
  nativeCurrency: { name: string; symbol: string; decimals: number };
};

export type EvmToken = {
  address: `0x${string}`;
  name: string;
  chainId: number;
  decimals: number;
};

export type EvmOrderView = {
  orderId: string;
  inputChainId: number;
  outputChainIds: number[];
  inputToken: string;
  outputToken: string;
  inputAmount: bigint;
  outputAmount: bigint;
  settler: "escrow" | "compact";
  expiresAt: number;
  fillDeadline: number;
};
