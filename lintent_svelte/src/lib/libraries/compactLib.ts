/// -- Compact -- ///
import { maxInt32, maxUint256, toHex } from "viem";
import { ResetPeriod, toId } from "@lifi/intent";
import { ADDRESS_ZERO, getChain, getClient, COMPACT, type WC } from "$lib/config";
import { COMPACT_ABI } from "$lib/abi/compact";
import { addressToBytes32 } from "@lifi/intent";
import { ERC20_ABI } from "$lib/abi/erc20";
import type { AppTokenContext } from "$lib/appTypes";

export class CompactLib {
  static compactDeposit(
    walletClient: WC,
    opts: {
      preHook?: (chainId: number) => Promise<any>;
      postHook?: () => Promise<any>;
      inputToken: AppTokenContext;
      account: () => `0x${string}`;
      allocatorId: string;
    }
  ) {
    return async () => {
      const { preHook, postHook, inputToken, account, allocatorId } = opts;
      const { token, amount } = inputToken;
      if (preHook) await preHook(token.chainId);
      const lockTag: `0x${string}` = `0x${toHex(
        toId(true, ResetPeriod.OneDay, allocatorId, ADDRESS_ZERO),
        {
          size: 32
        }
      )
        .replace("0x", "")
        .slice(0, 24)}`;
      const recipient = ADDRESS_ZERO; // This means sender.

      let transactionHash: `0x${string}`;
      if (token.address === ADDRESS_ZERO) {
        transactionHash = await walletClient.writeContract({
          chain: getChain(token.chainId),
          account: account(),
          address: COMPACT,
          abi: COMPACT_ABI,
          functionName: "depositNative",
          value: amount,
          args: [lockTag, recipient]
        });
      } else {
        transactionHash = await walletClient.writeContract({
          chain: getChain(token.chainId),
          account: account(),
          address: COMPACT,
          abi: COMPACT_ABI,
          functionName: "depositERC20",
          args: [token.address, lockTag, amount, recipient]
        });
      }
      await getClient(token.chainId).waitForTransactionReceipt({
        hash: await transactionHash
      });
      if (postHook) await postHook();
      return transactionHash;
    };
  }

  static compactWithdraw(
    walletClient: WC,
    opts: {
      preHook?: (chainId: number) => Promise<any>;
      postHook?: () => Promise<any>;
      inputToken: AppTokenContext;
      account: () => `0x${string}`;
      allocatorId: string;
    }
  ) {
    return async () => {
      const { preHook, postHook, inputToken, account, allocatorId } = opts;
      const { token, amount } = inputToken;
      const assetId = toId(true, ResetPeriod.OneDay, allocatorId, token.address);

      const allocatedTransferStruct: {
        allocatorData: `0x${string}`;
        nonce: bigint;
        expires: bigint;
        id: bigint;
        recipients: {
          claimant: bigint;
          amount: bigint;
        }[];
      } = {
        allocatorData: "0x", // TODO: Get from allocator
        nonce: BigInt(Math.floor(Math.random() * 2 ** 32)),
        expires: maxInt32, // TODO:
        id: assetId,
        recipients: [
          {
            claimant: BigInt(addressToBytes32(account())),
            amount: amount
          }
        ]
      };

      if (preHook) await preHook(token.chainId);
      const transactionHash = walletClient.writeContract({
        chain: getChain(token.chainId),
        account: account(),
        address: COMPACT,
        abi: COMPACT_ABI,
        functionName: "allocatedTransfer",
        args: [allocatedTransferStruct]
      });
      await getClient(token.chainId).waitForTransactionReceipt({
        hash: await transactionHash
      });
      if (postHook) await postHook();
      return transactionHash;
    };
  }

  static compactApprove(
    walletClient: WC,
    opts: {
      preHook?: (chainId: number) => Promise<any>;
      postHook?: () => Promise<any>;
      inputTokens: AppTokenContext[];
      account: () => `0x${string}`;
    }
  ) {
    return async () => {
      const { preHook, postHook, inputTokens, account } = opts;
      for (let i = 0; i < inputTokens.length; ++i) {
        const { token: inputToken, amount } = inputTokens[i];
        if (preHook) await preHook(inputToken.chainId);
        const publicClient = getClient(inputToken.chainId);
        // Check if we have sufficient allowance already.
        const currentAllowance = await publicClient.readContract({
          address: inputToken.address,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [account(), COMPACT]
        });
        if (currentAllowance >= amount) continue;
        const transactionHash = walletClient.writeContract({
          chain: getChain(inputToken.chainId),
          account: account(),
          address: inputToken.address,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [COMPACT, maxUint256]
        });

        await publicClient.waitForTransactionReceipt({
          hash: await transactionHash
        });
      }
      if (postHook) await postHook();
    };
  }
}
