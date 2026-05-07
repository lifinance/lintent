"use client";

import { useReadContract, useBalance } from "wagmi";
import { erc20Abi } from "viem";
import { ADDRESS_ZERO } from "../../lib/config/shared";

type UseEvmBalanceReturn = {
  balance: bigint | undefined;
  isLoading: boolean;
};

export function useEvmBalance(
  userAddress: `0x${string}` | undefined,
  tokenAddress: `0x${string}`,
  chainId: number,
): UseEvmBalanceReturn {
  const isNative = tokenAddress === ADDRESS_ZERO;

  const nativeBalance = useBalance({
    address: userAddress,
    chainId,
    query: { enabled: isNative && !!userAddress },
  });

  const tokenBalance = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: userAddress ? [userAddress] : undefined,
    chainId,
    query: { enabled: !isNative && !!userAddress },
  });

  if (isNative) {
    return { balance: nativeBalance.data?.value, isLoading: nativeBalance.isLoading };
  }
  return { balance: tokenBalance.data, isLoading: tokenBalance.isLoading };
}
