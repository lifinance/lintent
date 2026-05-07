"use client";
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { TokenContext } from "@lifi/intent";
import { useSvmWallet } from "./useSvmWallet.ts";
import { useSelectionStore } from "../../store/selection.ts";
import { useOrdersStore } from "../../store/orders.ts";
import { buildSvmIntentDeps, buildSvmIntent } from "../../lib/intent/svm.ts";
import {
  getSvmViemChainId,
  getSvmTokenByBytes32,
  getSolanaPrograms,
  getSolanaNetwork,
} from "../../lib/config/svm.ts";
import {
  bytes32ToSolanaAddress,
  solanaAddressToBytes32,
  toEvmAddress,
  addressToBytes32,
} from "../../lib/config/shared.ts";
import { openSolanaEscrow } from "../../lib/solver/solanaEscrow.ts";
import type { OrderContainer, SvmOrderData } from "../../types/shared.ts";
import type { SigningWalletAdapter } from "../../lib/solver/anchorTypes.ts";

type UseSvmIntentResult = {
  isSubmitting: boolean;
  error: string | null;
  submit: (recipient: string) => Promise<void>;
};

export function useSvmIntent(): UseSvmIntentResult {
  const { publicKey } = useSvmWallet();
  const wallet = useWallet();
  const { connection } = useConnection();
  const { mainnet, inputChains, outputChains } = useSelectionStore();
  const addOrder = useOrdersStore((s) => s.addOrder);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (recipient: string): Promise<void> => {
    const input = inputChains[0];
    if (!publicKey || !input || outputChains.length === 0) return;
    if (!wallet.wallet?.adapter) {
      setError("Solana wallet not connected");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const deps = buildSvmIntentDeps(mainnet);
      const network = getSolanaNetwork(mainnet);
      const programs = getSolanaPrograms(network);

      // Build output TokenContext array (EVM outputs from a Solana intent)
      const outputTokens: TokenContext[] = outputChains.map((out) => ({
        token: {
          address: toEvmAddress(out.tokenAddress),
          name: out.tokenName ?? "",
          chainId: BigInt(out.chainId),
          decimals: out.tokenDecimals ?? 18,
          chainNamespace: "eip155" as const,
        },
        amount: out.amount,
      }));

      const svmToken = getSvmTokenByBytes32(input.tokenAddress, mainnet);
      // bytes32Address is used as the token address for the intent library
      const mintBytes32 = (svmToken?.bytes32Address ?? input.tokenAddress) as `0x${string}`;

      const recipientBytes32 = addressToBytes32(toEvmAddress(recipient));

      const intent = buildSvmIntent(
        {
          account: publicKey,
          inputToken: {
            mintBytes32,
            name: svmToken?.name ?? "Unknown",
            chainId: BigInt(getSvmViemChainId(mainnet)),
            decimals: svmToken?.decimals ?? 9,
            amount: input.amount,
          },
          outputTokens,
          verifier: "polymer",
          outputRecipient: recipientBytes32,
        },
        deps,
      );

      const svmOrder = intent.asOrder();
      const orderId = intent.orderId();

      // Derive the token bytes32 from inputs[0][0] (bigint token representation)
      const tokenBytes32 = `0x${svmOrder.inputs[0][0].toString(16).padStart(64, "0")}` as `0x${string}`;

      const orderData: SvmOrderData = {
        kind: "svm_standard",
        user: bytes32ToSolanaAddress(svmOrder.user),
        userBytes32: svmOrder.user,
        nonce: svmOrder.nonce,
        originChainId: svmOrder.originChainId,
        expires: svmOrder.expires,
        fillDeadline: svmOrder.fillDeadline,
        inputOracle: bytes32ToSolanaAddress(svmOrder.inputOracle),
        inputOracleBytes32: svmOrder.inputOracle,
        input: {
          token: bytes32ToSolanaAddress(tokenBytes32),
          tokenBytes32,
          amount: svmOrder.inputs[0][1],
        },
        outputs: svmOrder.outputs,
      };

      await openSolanaEscrow({
        orderData,
        solanaPublicKey: publicKey,
        walletAdapter: wallet.wallet.adapter as SigningWalletAdapter,
        connection,
        mainnet,
      });

      const container: OrderContainer = {
        orderId,
        inputSettler: programs.INPUT_SETTLER_ESCROW as string,
        vm: "svm",
        settler: "escrow",
        sponsorSignature: { type: "None", payload: "0x" },
        allocatorSignature: { type: "None", payload: "0x" },
        order: orderData,
        createdAt: Math.floor(Date.now() / 1000),
      };

      addOrder(container);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return { isSubmitting, error, submit };
}
