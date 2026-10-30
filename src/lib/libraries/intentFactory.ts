import { validateApiQuote, type ApiQuoteContext, type SelectedApiQuote } from "./apiQuote";
import { openStellarApiOrder } from "./stellar";
import {
  getChain,
  getClient,
  INPUT_SETTLER_COMPACT_LIFI,
  INPUT_SETTLER_ESCROW_LIFI,
  requireAlignedAxelar,
  isStellarChain,
  MULTICHAIN_INPUT_SETTLER_ESCROW,
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
  StandardStellarIntent,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_TESTNET_CHAIN_ID,
  SOLANA_DEVNET_CHAIN_ID
} from "@lifi/intent";
import type { AppCreateIntentOptions, AppTokenContext } from "$lib/appTypes";
import { ERC20_ABI } from "$lib/abi/erc20";
import { store } from "$lib/state.svelte";
import { depositAndRegisterCompact, openEscrowIntent, signIntentCompact } from "./intentExecution";
import { openStellarIntent } from "./stellar";
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
      chainNamespace: isStellarChain(chainId)
        ? "stellar"
        : SOLANA_CHAIN_IDS.has(chainId)
          ? "solana"
          : "eip155"
    },
    amount: input.amount
  };
}

function toCoreCreateIntentOptions(opts: AppCreateIntentOptions): CreateIntentOptions {
  const account = opts.account();
  if (opts.verifier === "axelar") {
    for (const output of opts.outputTokens)
      requireAlignedAxelar(opts.inputTokens[0].token.chainId, output.token.chainId);
  }
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
  apiQuoteContext?: () => ApiQuoteContext;

  preHook?: (chainId: number) => Promise<any>;
  postHook?: () => Promise<any>;

  orders: OrderContainer[] = [];

  constructor(options: {
    mainnet: boolean;
    useProductionApi?: boolean | null;
    walletClient: WC;
    apiQuoteContext?: () => ApiQuoteContext;
    preHook?: (chainId: number) => Promise<any>;
    postHook?: () => Promise<any>;
    ordersPointer?: OrderContainer[];
  }) {
    const { mainnet, useProductionApi, walletClient, preHook, postHook, ordersPointer } = options;
    this.mainnet = mainnet;
    this.intentApi = new IntentApi(useProductionApi ?? mainnet);
    this.walletClient = walletClient;
    this.apiQuoteContext = options.apiQuoteContext;

    this.preHook = preHook;
    this.postHook = postHook;

    if (ordersPointer) this.orders = ordersPointer;
  }

  async executeApiQuote(quote: SelectedApiQuote) {
    if (!this.apiQuoteContext) throw new Error("Missing API quote request context");
    const context = this.apiQuoteContext();
    const chainId = context.inputs[0].token.chainId;
    let validated = validateApiQuote(quote, context);
    const tx = quote.order.openIntentTx;
    let hash: `0x${string}`;
    if (isStellarChain(chainId)) {
      const source = store.stellarAccounts[chainId];
      if (source !== context.user || !validated.scval)
        throw new Error("Stellar quote account changed");
      const receipt = await openStellarApiOrder(chainId, tx.to, validated.scval, source, () => {
        validateApiQuote(quote, this.apiQuoteContext!());
        if (store.stellarAccounts[chainId] !== source)
          throw new Error("Stellar quote account changed");
      });
      hash = receipt.hash;
      await store.saveStellarTransaction(chainId, hash, receipt);
    } else {
      if (this.preHook) await this.preHook(chainId);
      const [address] = await this.walletClient.getAddresses();
      if (
        address?.toLowerCase() !== context.user.toLowerCase() ||
        (await this.walletClient.getChainId()) !== chainId
      )
        throw new Error("Quote wallet account/network changed");
      for (const allowance of quote.order.checks.allowances) {
        validated = validateApiQuote(quote, this.apiQuoteContext());
        const client = getClient(chainId);
        const token = allowance.token as `0x${string}`;
        const spender = allowance.spender as `0x${string}`;
        const current = await client.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [address, spender]
        });
        if (current < BigInt(allowance.required)) {
          validateApiQuote(quote, this.apiQuoteContext());
          const approval = await this.walletClient.writeContract({
            chain: getChain(chainId),
            account: address,
            address: token,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [spender, BigInt(allowance.required)]
          });
          await client.waitForTransactionReceipt({ hash: approval });
        }
      }
      validated = validateApiQuote(quote, this.apiQuoteContext());
      const [currentAddress] = await this.walletClient.getAddresses();
      if (
        currentAddress?.toLowerCase() !== address.toLowerCase() ||
        (await this.walletClient.getChainId()) !== chainId
      )
        throw new Error("Quote wallet account/network changed before signing");
      hash = await this.walletClient.sendTransaction({
        chain: getChain(chainId),
        account: address,
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: BigInt(tx.value ?? "0")
      });
      const receipt = await getClient(chainId).waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("API quote open reverted");
      await store.saveTransactionReceipt(chainId, hash, receipt);
    }
    await this.saveOrder({
      order: validated.order,
      inputSettler: isStellarChain(chainId) ? validated.inputSettler : (tx.to as `0x${string}`),
      apiQuote: quote
    });
    if (this.postHook) await this.postHook();
    return hash;
  }

  private async saveOrder(options: {
    order: StandardOrder | MultichainOrder;
    inputSettler: `0x${string}`;
    sponsorSignature?: Signature | NoSignature;
    allocatorSignature?: Signature | NoSignature;
    apiQuote?: SelectedApiQuote;
  }) {
    const { order, inputSettler, sponsorSignature, allocatorSignature, apiQuote } = options;

    const orderContainer: OrderContainer & { apiQuote?: SelectedApiQuote } = {
      order,
      ...(apiQuote ? { apiQuote } : {}),
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
      if (this.preHook) await this.preHook(inputChain);
      const intentInstance = new Intent(toCoreCreateIntentOptions(opts), intentDeps);
      applySameChainTimings(intentInstance);
      const sameChain = intentInstance.isSameChain();
      const intent = intentInstance.order();
      if (intent instanceof StandardSolanaIntent)
        throw new Error("Compact signing is not supported for Solana intents.");
      if (intent instanceof StandardStellarIntent)
        throw new Error("Stellar inputs only support escrow");
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
      const intentInstance2 = new Intent(toCoreCreateIntentOptions(opts), intentDeps);
      applySameChainTimings(intentInstance2);
      const sameChain2 = intentInstance2.isSameChain();
      const intent = intentInstance2.singlechain();
      if (intent instanceof StandardSolanaIntent)
        throw new Error("Compact deposit and register is not supported for Solana intents.");
      if (intent instanceof StandardStellarIntent)
        throw new Error("Stellar inputs only support escrow");
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

      if (intent instanceof StandardStellarIntent) {
        const open = await openStellarIntent(intent, store.stellarAccount);
        if (this.postHook) await this.postHook();
        await this.saveOrder({ order: intent.asOrder(), inputSettler: intent.inputSettler });
        return [open.hash];
      }

      applyExclusivityOverride(intent, opts.exclusiveFor, sameChain3);

      const inputChain = inputTokens[0].token.chainId;
      if (this.preHook) await this.preHook(inputChain);

      // Execute the open.
      const transactionHashes = await openEscrowIntent(intent, account(), this.walletClient);
      console.log({ tsh: transactionHashes });

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
      // The Stellar escrow pulls inputs with an authorised transfer; nothing to approve.
      if (isStellarChain(token.chainId)) continue;
      if (preHook) await preHook(token.chainId);
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
