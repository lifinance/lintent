import {
  getChain,
  getClient,
  INPUT_SETTLER_COMPACT_LIFI,
  INPUT_SETTLER_ESCROW_LIFI,
  MULTICHAIN_INPUT_SETTLER_ESCROW,
  TRON_MAINNET_INPUT_SETTLER,
  type WC
} from "$lib/config";
import { encodePacked, maxUint256 } from "viem";
import type {
  CreateIntentOptions,
  TokenContext,
  MultichainOrder,
  NoSignature,
  OrderContainer,
  Signature,
  StandardOrder
} from "@lifi/intent";
import {
  Intent,
  IntentApi,
  StandardSolanaIntent,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_TESTNET_CHAIN_ID,
  SOLANA_DEVNET_CHAIN_ID
} from "@lifi/intent";
import { isTronChain } from "$lib/utils/chainType";
import type { AppCreateIntentOptions, AppTokenContext } from "$lib/appTypes";
import { ERC20_ABI } from "$lib/abi/erc20";
import { store } from "$lib/state.svelte";
import { depositAndRegisterCompact, openEscrowIntent, signIntentCompact } from "./intentExecution";
import { approveTronToken } from "./tronExecution";
import { intentDeps } from "./coreDeps";

const SOLANA_CHAIN_IDS = new Set([
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_TESTNET_CHAIN_ID,
  SOLANA_DEVNET_CHAIN_ID
]);

const SAME_CHAIN_DURATION_SECONDS = 10 * 60; // 10 minutes
const SAME_CHAIN_EXCLUSIVITY_SECONDS = 12 * 3; // 36 seconds

function applySameChainTimings(intent: Intent): void {
  if (!intent.isSameChain()) return;
  const mutable = intent as unknown as { expiry: number; fillDeadline: number };
  mutable.expiry = SAME_CHAIN_DURATION_SECONDS;
  mutable.fillDeadline = SAME_CHAIN_DURATION_SECONDS;
}

function applyExclusivityOverride(
  orderIntent: ReturnType<Intent["order"]>,
  exclusiveFor: string | undefined,
  isSameChain: boolean
): void {
  if (!isSameChain || !exclusiveFor) return;
  const order = orderIntent.asOrder() as StandardOrder;
  const currentTime = Math.floor(Date.now() / 1000);
  const paddedExclusiveFor =
    `0x${exclusiveFor.replace("0x", "").padStart(64, "0")}` as `0x${string}`;
  const newContext = encodePacked(
    ["bytes1", "bytes32", "uint32"],
    ["0xe0", paddedExclusiveFor, currentTime + SAME_CHAIN_EXCLUSIVITY_SECONDS]
  );
  for (const output of order.outputs) {
    if (output.context !== "0x") {
      output.context = newContext;
    }
  }
}

function toCoreTokenContext(input: AppTokenContext): TokenContext {
  const chainId = BigInt(input.token.chainId);
  return {
    token: {
      address: input.token.address,
      name: input.token.name,
      chainId,
      decimals: input.token.decimals,
      chainNamespace: SOLANA_CHAIN_IDS.has(chainId)
        ? "solana"
        : isTronChain(chainId)
          ? "tron"
          : "eip155"
    },
    amount: input.amount
  };
}

function toCoreCreateIntentOptions(opts: AppCreateIntentOptions): CreateIntentOptions {
  const account = opts.account();
  if (opts.lock.type === "compact") {
    return {
      exclusiveFor: opts.exclusiveFor,
      inputTokens: opts.inputTokens.map(toCoreTokenContext),
      outputTokens: opts.outputTokens.map(toCoreTokenContext),
      verifier: opts.verifier,
      account,
      outputRecipient: opts.outputRecipient,
      lock: {
        type: "compact",
        resetPeriod: opts.lock.resetPeriod,
        allocatorId: opts.lock.allocatorId
      }
    };
  }

  return {
    exclusiveFor: opts.exclusiveFor,
    inputTokens: opts.inputTokens.map(toCoreTokenContext),
    outputTokens: opts.outputTokens.map(toCoreTokenContext),
    verifier: opts.verifier,
    account,
    outputRecipient: opts.outputRecipient,
    lock: {
      type: "escrow"
    }
  };
}

/**
 * @notice Factory class for creating and managing intents. Functions called by integrators.
 */
export class IntentFactory {
  mainnet: boolean;
  intentApi: IntentApi;

  walletClient: WC;

  preHook?: (chainId: number) => Promise<any>;
  postHook?: () => Promise<any>;

  orders: OrderContainer[] = [];

  constructor(options: {
    mainnet: boolean;
    useProductionApi?: boolean | null;
    walletClient: WC;
    preHook?: (chainId: number) => Promise<any>;
    postHook?: () => Promise<any>;
    ordersPointer?: OrderContainer[];
  }) {
    const { mainnet, useProductionApi, walletClient, preHook, postHook, ordersPointer } = options;
    this.mainnet = mainnet;
    this.intentApi = new IntentApi(useProductionApi ?? mainnet);
    this.walletClient = walletClient;

    this.preHook = preHook;
    this.postHook = postHook;

    if (ordersPointer) this.orders = ordersPointer;
  }

  private async saveOrder(options: {
    order: StandardOrder | MultichainOrder;
    inputSettler: `0x${string}`;
    sponsorSignature?: Signature | NoSignature;
    allocatorSignature?: Signature | NoSignature;
  }) {
    const { order, inputSettler, sponsorSignature, allocatorSignature } = options;

    const orderContainer: OrderContainer = {
      order,
      inputSettler,
      sponsorSignature: sponsorSignature ?? {
        type: "None",
        payload: "0x"
      },
      allocatorSignature: allocatorSignature ?? {
        type: "None",
        payload: "0x"
      }
    };
    this.orders.push(orderContainer);
    await store.saveOrderToDb(orderContainer);
  }

  compact(opts: AppCreateIntentOptions) {
    return async () => {
      const { account, inputTokens } = opts;
      const inputChain = inputTokens[0].token.chainId;
      if (isTronChain(inputChain)) {
        throw new Error(
          "Compact intents are not supported for Tron — pending protocol decision on signing scheme"
        );
      }
      if (this.preHook) await this.preHook(inputChain);
      const intentInstance = new Intent(toCoreCreateIntentOptions(opts), intentDeps);
      applySameChainTimings(intentInstance);
      const sameChain = intentInstance.isSameChain();
      const intent = intentInstance.order();
      if (intent instanceof StandardSolanaIntent)
        throw new Error("Compact signing is not supported for Solana intents.");
      applyExclusivityOverride(intent, opts.exclusiveFor, sameChain);

      const sponsorSignature = await signIntentCompact(intent, account(), this.walletClient);

      console.log({
        order: intent.asOrder(),
        sponsorSignature
      });

      await this.saveOrder({
        order: intent.asOrder(),
        inputSettler: intent.inputSettler,
        sponsorSignature: {
          type: "ECDSA",
          payload: sponsorSignature
        }
      });

      const order = intent.asOrder();
      if (!("originChainId" in order)) {
        throw new Error("CatalystCompactOrder submission currently supports standard orders.");
      }
      const signedOrder = await this.intentApi.submitOrder({
        orderType: "CatalystCompactOrder",
        order,
        inputSettler: INPUT_SETTLER_COMPACT_LIFI,
        sponsorSignature,
        allocatorSignature: "0x"
      });
      console.log("signedOrder", signedOrder);

      if (this.postHook) await this.postHook();
    };
  }

  compactDepositAndRegister(opts: AppCreateIntentOptions) {
    return async () => {
      const { inputTokens, account } = opts;
      if (isTronChain(inputTokens[0].token.chainId)) {
        throw new Error(
          "Compact intents are not supported for Tron — pending protocol decision on signing scheme"
        );
      }
      const intentInstance2 = new Intent(toCoreCreateIntentOptions(opts), intentDeps);
      applySameChainTimings(intentInstance2);
      const sameChain2 = intentInstance2.isSameChain();
      const intent = intentInstance2.singlechain();
      if (intent instanceof StandardSolanaIntent)
        throw new Error("Compact deposit and register is not supported for Solana intents.");
      applyExclusivityOverride(intent, opts.exclusiveFor, sameChain2);

      if (this.preHook) await this.preHook(inputTokens[0].token.chainId);

      let transactionHash = await depositAndRegisterCompact(intent, account(), this.walletClient);

      const receipt = await getClient(inputTokens[0].token.chainId).waitForTransactionReceipt({
        hash: transactionHash
      });

      // If you use another allocator than polymer, there should be logic for potentially getting the allocator signature here.
      // You may consider getting the allocator signature before you call depositAndRegisterCompact

      // Add the order to our local order list.
      await this.saveOrder({
        order: intent.asOrder(),
        inputSettler: INPUT_SETTLER_COMPACT_LIFI
      });

      // Submit the order to the intent-api.
      const unsignedOrder = await this.intentApi.submitOrder({
        orderType: "CatalystCompactOrder",
        order: intent.asOrder(),
        inputSettler: INPUT_SETTLER_COMPACT_LIFI,
        compactRegistrationTxHash: transactionHash
      });

      console.log("unsignedOrder", unsignedOrder);
      if (this.postHook) await this.postHook();
    };
  }

  openIntent(opts: AppCreateIntentOptions) {
    return async () => {
      const { inputTokens, account } = opts;
      const intentInstance3 = new Intent(toCoreCreateIntentOptions(opts), intentDeps);
      applySameChainTimings(intentInstance3);
      const sameChain3 = intentInstance3.isSameChain();
      const intent = intentInstance3.order();
      if (intent instanceof StandardSolanaIntent)
        throw new Error("openEscrowIntent is not supported for Solana intents.");
      applyExclusivityOverride(intent, opts.exclusiveFor, sameChain3);

      const inputChain = inputTokens[0].token.chainId;
      if (this.preHook) await this.preHook(inputChain);

      // Execute the open.
      const transactionHashes = await openEscrowIntent(intent, account(), this.walletClient);
      console.log({ tsh: transactionHashes });

      // for (const hash of transactionHashes) {
      // 	await clients[inputChain].waitForTransactionReceipt({
      // 		hash: await hash
      // 	});
      // }

      if (this.postHook) await this.postHook();

      await this.saveOrder({
        order: intent.asOrder(),
        inputSettler: intent.inputSettler
      });

      return transactionHashes;
    };
  }
}

export function escrowApprove(
  walletClient: WC,
  opts: {
    preHook?: (chainId: number) => Promise<any>;
    postHook?: () => Promise<any>;
    inputTokens: AppTokenContext[];
    account: () => `0x${string}`;
  }
) {
  return async () => {
    const settler = store.multichain ? MULTICHAIN_INPUT_SETTLER_ESCROW : INPUT_SETTLER_ESCROW_LIFI;

    const { preHook, postHook, inputTokens, account } = opts;
    for (let i = 0; i < inputTokens.length; ++i) {
      const { token, amount } = inputTokens[i];
      if (preHook) await preHook(token.chainId);

      if (isTronChain(token.chainId)) {
        await approveTronToken(token.address, TRON_MAINNET_INPUT_SETTLER, amount);
        continue;
      }

      const publicClient = getClient(token.chainId);
      const currentAllowance = await publicClient.readContract({
        address: token.address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account(), settler]
      });
      if (currentAllowance >= amount) continue;
      const transactionHash = walletClient.writeContract({
        chain: getChain(token.chainId),
        account: account(),
        address: token.address,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [settler, maxUint256]
      });

      await publicClient.waitForTransactionReceipt({
        hash: await transactionHash
      });
    }
    if (postHook) await postHook();
  };
}
