"use client";

import { useState } from "react";
import { useWalletClient } from "wagmi";
import type { WalletClient } from "viem";
import {
  type CreateIntentOptions,
  type TokenContext,
  type TypedDataSigner,
  ResetPeriod,
  StandardEVMIntent,
  MultichainOrderIntent,
  INPUT_SETTLER_ESCROW_LIFI,
  INPUT_SETTLER_COMPACT_LIFI,
  MULTICHAIN_INPUT_SETTLER_ESCROW,
  signStandardCompact,
  signMultichainCompact,
  addressToBytes32,
} from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import { IntentApi } from "../../lib/intent/api.ts";
import { useEvmWallet } from "./useEvmWallet.ts";
import { useSelectionStore } from "../../store/selection.ts";
import { useOrdersStore } from "../../store/orders.ts";
import { buildEvmIntentDeps, buildEvmIntent } from "../../lib/intent/evm.ts";
import { getEvmChain, getEvmClient, POLYMER_ORACLE } from "../../lib/config/evm.ts";
import {
  toEvmAddress,
  isSolanaAddress,
  solanaAddressToBytes32,
} from "../../lib/config/shared.ts";
import {
  isSolanaViemChainId,
  getSvmViemChainId,
  getSolanaPdas,
  getSolanaNetwork,
} from "../../lib/config/svm.ts";
import { SETTLER_ESCROW_ABI } from "../../lib/abi/escrow.ts";
import { ERC20_ABI } from "../../lib/abi/erc20.ts";
import type {
  OrderContainer,
  StandardOrderData,
  MultichainOrderData,
  SettlerType,
} from "../../types/shared.ts";
import type { SelectedChainToken } from "../../store/selection.ts";
import { isAddress, maxUint256 } from "viem";

type UseEvmIntentResult = {
  isSubmitting: boolean;
  error: string | null;
  submit: (settler: SettlerType, recipient?: string) => Promise<void>;
};

function selectionToTokenContext(
  sel: { chainId: number; tokenAddress: string; tokenDecimals: number; tokenName: string; amount: bigint },
): TokenContext {
  return {
    token: {
      address: toEvmAddress(sel.tokenAddress),
      name: sel.tokenName,
      chainId: BigInt(sel.chainId),
      decimals: sel.tokenDecimals,
      chainNamespace: "eip155" as const,
    },
    amount: sel.amount,
  };
}

function buildSolanaMandateOutputs(
  solanaOutputs: SelectedChainToken[],
  bytes32Recipient: `0x${string}`,
  mainnet: boolean,
): MandateOutput[] {
  const network = getSolanaNetwork(mainnet);
  const pdas = getSolanaPdas(network);
  const solanaViemChainId = getSvmViemChainId(mainnet);
  return solanaOutputs.map((sel) => ({
    oracle: pdas.POLYMER_ORACLE as `0x${string}`,
    settler: pdas.OUTPUT_SETTLER as `0x${string}`,
    chainId: BigInt(solanaViemChainId),
    token: sel.tokenAddress as `0x${string}`,
    amount: sel.amount,
    recipient: bytes32Recipient,
    callbackData: "0x" as `0x${string}`,
    context: "0x" as `0x${string}`,
  }));
}

const ONE_HOUR = 3600;
const ONE_DAY = 86400;

function buildSolanaOnlyIntent(
  account: `0x${string}`,
  inputTokens: TokenContext[],
  solanaOutputs: MandateOutput[],
  deps: { getOracle: (verifier: string, chainId: bigint) => `0x${string}` | undefined },
  settler: SettlerType,
): StandardEVMIntent {
  const firstInput = inputTokens[0];
  if (!firstInput) throw new Error("Intent requires at least one input token");

  const inputChain = firstInput.token.chainId;
  const inputs: [bigint, bigint][] = inputTokens.map(({ token, amount }) => [
    BigInt(token.address),
    amount,
  ]);

  const currentTime = Math.floor(Date.now() / 1000);
  const oracleAddr = deps.getOracle("polymer", inputChain);
  if (!oracleAddr) {
    const polymerAddr = POLYMER_ORACLE[Number(inputChain)];
    if (!polymerAddr) throw new Error(`No Polymer oracle for chain ${inputChain}`);
  }
  const inputOracle = (oracleAddr ?? POLYMER_ORACLE[Number(inputChain)]!) as `0x${string}`;
  const nonce = BigInt(1 + Math.floor(Math.random() * (2 ** 32 - 1)));

  const order = {
    user: account,
    nonce,
    originChainId: inputChain,
    fillDeadline: currentTime + 2 * ONE_HOUR,
    expires: currentTime + ONE_DAY,
    inputOracle,
    inputs,
    outputs: solanaOutputs,
  };

  const inputSettler = settler === "escrow"
    ? INPUT_SETTLER_ESCROW_LIFI
    : INPUT_SETTLER_COMPACT_LIFI;

  return new StandardEVMIntent(
    inputSettler as `0x${string}`,
    order,
  );
}

export function useEvmIntent(): UseEvmIntentResult {
  const { address, isConnected } = useEvmWallet();
  const { data: walletClient } = useWalletClient();
  const { mainnet, inputChains, outputChains } = useSelectionStore();
  const addOrder = useOrdersStore((s) => s.addOrder);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (settler: SettlerType, recipient?: string): Promise<void> => {
    if (!isConnected || !address || !walletClient || inputChains.length === 0 || outputChains.length === 0) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const deps = buildEvmIntentDeps(mainnet);

      const evmOutputSelections = outputChains.filter((c) => !isSolanaViemChainId(c.chainId));
      const solanaOutputSelections = outputChains.filter((c) => isSolanaViemChainId(c.chainId));

      let bytes32Recipient: `0x${string}` | undefined;
      let outputRecipient: `0x${string}` | undefined;
      if (recipient && isSolanaAddress(recipient)) {
        bytes32Recipient = solanaAddressToBytes32(recipient) as `0x${string}`;
        outputRecipient = bytes32Recipient;
      } else if (recipient && isAddress(recipient, { strict: false })) {
        outputRecipient = toEvmAddress(recipient);
      }

      const solanaRecipient = bytes32Recipient ?? addressToBytes32(toEvmAddress(address));

      let intent: StandardEVMIntent | MultichainOrderIntent;

      if (evmOutputSelections.length > 0) {
        const baseOpts = {
          account: toEvmAddress(address),
          inputTokens: inputChains.map(selectionToTokenContext),
          outputTokens: evmOutputSelections.map(selectionToTokenContext),
          verifier: "polymer" as const,
          outputRecipient,
        };
        const opts: CreateIntentOptions = settler === "compact"
          ? { ...baseOpts, lock: { type: "compact" as const, resetPeriod: ResetPeriod.OneHourAndFiveMinutes, allocatorId: "" } }
          : { ...baseOpts, lock: { type: "escrow" as const } };

        intent = buildEvmIntent(opts, deps);

        if (solanaOutputSelections.length > 0) {
          const solanaMandates = buildSolanaMandateOutputs(solanaOutputSelections, solanaRecipient, mainnet);
          // The intent library only saw the EVM outputs when it picked
          // `inputOracle`. If those EVM outputs happen to be same-chain as the
          // input, the library short-circuits to `inputOracle = COIN_FILLER`,
          // which has no Polymer proof verification. Once we tack on Solana
          // outputs, the order is genuinely cross-chain — force `inputOracle`
          // back to the Polymer oracle so Solana fills can be validated.
          const stdOrder = intent instanceof StandardEVMIntent
            ? intent.asOrder()
            : (intent as MultichainOrderIntent).asOrder();
          stdOrder.outputs.push(...solanaMandates);
          const inputChainId = intent instanceof StandardEVMIntent
            ? Number(intent.asOrder().originChainId)
            : Number((intent as MultichainOrderIntent).asOrder().inputs[0]?.chainId ?? 0n);
          const polymerForInput = deps.getOracle("polymer", BigInt(inputChainId));
          if (polymerForInput && intent instanceof StandardEVMIntent) {
            intent.asOrder().inputOracle = polymerForInput;
          }
        }
      } else {
        const solanaMandates = buildSolanaMandateOutputs(solanaOutputSelections, solanaRecipient, mainnet);
        intent = buildSolanaOnlyIntent(
          toEvmAddress(address),
          inputChains.map(selectionToTokenContext),
          solanaMandates,
          deps,
          settler,
        );
      }

      const orderId = intent.orderId();

      let sponsorSignature: `0x${string}` | undefined;

      if (settler === "escrow") {
        await approveAndOpenEscrow(intent, address, walletClient);
      } else {
        sponsorSignature = await signAndSubmitCompact(intent, address, walletClient, mainnet);
      }

      const inputSettler = intent.inputSettler as `0x${string}`;
      const sigPayload = sponsorSignature
        ? { type: "ECDSA" as const, payload: sponsorSignature }
        : { type: "None" as const, payload: "0x" as const };

      if (intent instanceof StandardEVMIntent) {
        const stdOrder = intent.asOrder();
        const orderData: StandardOrderData = {
          kind: "standard",
          user: stdOrder.user as `0x${string}`,
          nonce: stdOrder.nonce,
          originChainId: stdOrder.originChainId,
          expires: stdOrder.expires,
          fillDeadline: stdOrder.fillDeadline,
          inputOracle: stdOrder.inputOracle as `0x${string}`,
          inputs: stdOrder.inputs,
          outputs: stdOrder.outputs,
        };

        const container: OrderContainer = {
          orderId,
          inputSettler,
          vm: "evm",
          settler,
          sponsorSignature: sigPayload,
          allocatorSignature: { type: "None", payload: "0x" },
          order: orderData,
          createdAt: Math.floor(Date.now() / 1000),
        };
        addOrder(container);
      } else {
        const multiOrder = (intent as MultichainOrderIntent).asOrder();
        const orderData: MultichainOrderData = {
          kind: "multichain",
          user: multiOrder.user as `0x${string}`,
          nonce: multiOrder.nonce,
          expires: multiOrder.expires,
          fillDeadline: multiOrder.fillDeadline,
          inputOracle: multiOrder.inputOracle as `0x${string}`,
          outputs: multiOrder.outputs,
          inputs: multiOrder.inputs,
        };

        const container: OrderContainer = {
          orderId,
          inputSettler,
          vm: "evm",
          settler,
          sponsorSignature: sigPayload,
          allocatorSignature: { type: "None", payload: "0x" },
          order: orderData,
          createdAt: Math.floor(Date.now() / 1000),
        };
        addOrder(container);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return { isSubmitting, error, submit };
}

async function switchWalletChain(
  walletClient: WalletClient,
  targetChainId: number,
): Promise<void> {
  if (walletClient.chain?.id === targetChainId) return;
  await walletClient.switchChain({ id: targetChainId });
}

async function approveAndOpenEscrow(
  intent: StandardEVMIntent | MultichainOrderIntent,
  account: `0x${string}`,
  walletClient: WalletClient,
): Promise<void> {
  if (intent instanceof StandardEVMIntent) {
    const order = intent.asOrder();
    const chainId = Number(order.originChainId);
    const chain = getEvmChain(chainId);
    const publicClient = getEvmClient(chainId);

    await switchWalletChain(walletClient, chainId);

    for (const [tokenId, amount] of order.inputs) {
      const tokenAddress = `0x${tokenId.toString(16).padStart(40, "0")}` as `0x${string}`;
      if (tokenAddress === "0x0000000000000000000000000000000000000000") continue;

      const allowance = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account, INPUT_SETTLER_ESCROW_LIFI as `0x${string}`],
      });
      if (BigInt(allowance) >= amount) continue;
      const approveTx = await walletClient.writeContract({
        chain,
        account,
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [INPUT_SETTLER_ESCROW_LIFI as `0x${string}`, maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
    }

    const openTx = await walletClient.writeContract({
      chain,
      account,
      address: INPUT_SETTLER_ESCROW_LIFI as `0x${string}`,
      abi: SETTLER_ESCROW_ABI,
      functionName: "open",
      args: [order as never],
    });
    await publicClient.waitForTransactionReceipt({ hash: openTx });
    return;
  }

  const components = intent.asComponents();
  for (const { chainId, orderComponent } of components) {
    const numericChainId = Number(chainId);
    const chain = getEvmChain(numericChainId);
    const publicClient = getEvmClient(numericChainId);

    await switchWalletChain(walletClient, numericChainId);

    for (const [tokenId, amount] of orderComponent.inputs) {
      const tokenAddress = `0x${tokenId.toString(16).padStart(40, "0")}` as `0x${string}`;
      if (tokenAddress === "0x0000000000000000000000000000000000000000") continue;

      const allowance = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account, MULTICHAIN_INPUT_SETTLER_ESCROW as `0x${string}`],
      });
      if (BigInt(allowance) >= amount) continue;
      const approveTx = await walletClient.writeContract({
        chain,
        account,
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [MULTICHAIN_INPUT_SETTLER_ESCROW as `0x${string}`, maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
    }

    const openTx = await walletClient.writeContract({
      chain,
      account,
      address: intent.inputSettler as `0x${string}`,
      abi: SETTLER_ESCROW_ABI,
      functionName: "open",
      args: [orderComponent as never],
    });
    await publicClient.waitForTransactionReceipt({ hash: openTx });
  }
}

async function signAndSubmitCompact(
  intent: StandardEVMIntent | MultichainOrderIntent,
  account: `0x${string}`,
  walletClient: WalletClient,
  mainnet: boolean,
): Promise<`0x${string}`> {
  const signer = walletClient as unknown as TypedDataSigner;
  let sponsorSignature: `0x${string}`;

  const evmAccount = toEvmAddress(account);

  if (intent instanceof StandardEVMIntent) {
    const order = intent.asOrder();
    sponsorSignature = await signStandardCompact(
      evmAccount,
      signer,
      order.originChainId,
      intent.asBatchCompact(),
    );

    const api = new IntentApi(mainnet);
    await api.submitOrder({
      orderType: "CatalystCompactOrder",
      order,
      inputSettler: INPUT_SETTLER_COMPACT_LIFI as `0x${string}`,
      sponsorSignature,
      allocatorSignature: "0x",
    });
  } else {
    const multiIntent = intent as MultichainOrderIntent;
    const order = multiIntent.asOrder();
    const firstChainId = order.inputs[0]?.chainId ?? 0n;
    sponsorSignature = await signMultichainCompact(
      evmAccount,
      signer,
      firstChainId,
      multiIntent.asMultichainBatchCompact(),
    );

    const api = new IntentApi(mainnet);
    await api.submitOrder({
      orderType: "CatalystCompactOrder",
      order: order as never,
      inputSettler: intent.inputSettler as `0x${string}`,
      sponsorSignature,
      allocatorSignature: "0x",
    });
  }

  return sponsorSignature;
}
