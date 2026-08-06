import { maxUint256 } from "viem";
import { COMPACT_ABI } from "../abi/compact";
import { ERC20_ABI } from "../abi/erc20";
import { ADDRESS_ZERO, clients, COMPACT } from "../config";
import { ResetPeriod, toId } from "@lifi/intent";

export async function getBalance(
  user: `0x${string}` | undefined,
  asset: `0x${string}`,
  client: (typeof clients)[keyof typeof clients]
) {
  if (!user) return 0n;
  if (asset === ADDRESS_ZERO) {
    return client.getBalance({
      address: user,
      blockTag: "latest"
    });
  } else {
    return client.readContract({
      address: asset,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [user]
    });
  }
}

export function getAllowance(contract: `0x${string}`) {
  return async (
    user: `0x${string}` | undefined,
    asset: `0x${string}`,
    client: (typeof clients)[keyof typeof clients]
  ) => {
    if (!user) return 0n;
    if (asset == ADDRESS_ZERO) return maxUint256;
    return client.readContract({
      address: asset,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [user, contract]
    });
  };
}

export async function getCompactBalance(
  user: `0x${string}` | undefined,
  asset: `0x${string}`,
  client: (typeof clients)[keyof typeof clients],
  allocatorId: string
) {
  if (!user) return 0n;
  const assetId = toId(true, ResetPeriod.OneDay, allocatorId, asset);
  try {
    return await client.readContract({
      address: COMPACT,
      abi: COMPACT_ABI,
      functionName: "balanceOf",
      args: [user, assetId]
    });
  } catch {
    return 0n;
  }
}
