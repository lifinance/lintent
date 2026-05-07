// SVM-specific app types
export type SvmChain = {
  viemChainId: number;      // 1151111081099712 (viem defineChain id)
  intentsChainId: number;   // 11 (used in MandateOutput.chainId)
  name: string;
  displayName: string;
  rpcUrl: string;
};

export type SvmToken = {
  mintAddress: string;  // base58 public key
  bytes32Address: `0x${string}`; // bytes32 encoding for MandateOutput.token
  name: string;
  decimals: number;
};

export type SvmOrderView = {
  orderId: string;
  outputChainIds: number[];
  inputToken: string;
  outputToken: string;
  inputAmount: bigint;
  outputAmount: bigint;
  expiresAt: number;
  fillDeadline: number;
};
