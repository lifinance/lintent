import {
  validateApiQuoteExecution,
  type ApiQuoteContext,
  type ApiQuoteSelection,
  type SelectedApiQuote
} from "./apiQuote";
import { openStellarApiOrder, openStellarIntent } from "./stellar";
import {
  getChain,
  getClient,
  INPUT_SETTLER_COMPACT_LIFI,
  INPUT_SETTLER_ESCROW_LIFI,
  axelarCorridor,
  isStellarChain,
  MULTICHAIN_INPUT_SETTLER_ESCROW,
  TRON_MAINNET_INPUT_SETTLER,
  type WC
} from "$lib/config";
import { maxUint256 } from "viem";
import type {
  CreateIntentOptions,
  TokenContext,
  MultichainOrder,
  NoSignature,
  OrderContainer,
  Signature,
  StandardOrder
} from "@lifi/intent";
import { Intent, IntentApi, StandardSolanaIntent, StandardStellarIntent } from "@lifi/intent";
import { isSolanaChain, isTronChain, namespaceForChain } from "$lib/utils/chainType";
import { resolveProductionApi } from "$lib/utils/intentApiEnv";
import type { AppCreateIntentOptions, AppTokenContext } from "$lib/appTypes";
import { ERC20_ABI } from "$lib/abi/erc20";
import { store } from "$lib/state.svelte";
import { depositAndRegisterCompact, openEscrowIntent, signIntentCompact } from "./intentExecution";
import { ADDRESS_ZERO } from "@lifi/intent";
import { getTronReads, getTronSigner } from "$lib/tron/client";
import { getTrc20Allowance } from "$lib/tron/reads";
import { approveToken } from "$lib/tron/writes";
import { intentDeps } from "./coreDeps";

const FILL_DEADLINE_SECONDS = 10 * 60; // 10 minutes
// Must stay strictly greater than FILL_DEADLINE_SECONDS: the Solana input
// settler requires `fill_deadline < expires` (EVM only rejects `>`), so equal
// deadlines fail `open` with FillDeadlineAfterExpiry on same-chain Solana.
const SAME_CHAIN_DURATION_SECONDS = 20 * 60; // 20 minutes
const SAME_CHAIN_EXCLUSIVITY_SECONDS = 12 * 3; // 36 seconds
// SOLV-544 widened the exclusivity window to 5 minutes so solvers have time to
// fill before exclusivity ends; @lifi/intent still defaults to one minute.
const CROSS_CHAIN_EXCLUSIVITY_SECONDS = 5 * 60; // 5 minutes

function applyIntentTimings(intent: Intent): void {
  // Every intent gets a 10 minute fill deadline, overriding the `@lifi/intent`
  // default of 44h (set by EXP-432 to match lifi-backend). `expiry` is left on
  // the library default for cross-chain intents so the reclaim window still
  // clears settlement; same-chain intents shorten it to match below.
  intent.setFillDeadline(FILL_DEADLINE_SECONDS);
  // The library encodes the exclusive context itself (validating the solver
  // against the input chain's namespace and keeping the Stellar recipient
  // tag); only the window differs from its 1 minute default.
  if (!intent.isSameChain()) {
    intent.setExclusivity(CROSS_CHAIN_EXCLUSIVITY_SECONDS);
    return;
  }
  intent.setExpiry(SAME_CHAIN_DURATION_SECONDS);
  intent.setExclusivity(SAME_CHAIN_EXCLUSIVITY_SECONDS);
}

function toCoreTokenContext(input: AppTokenContext): TokenContext {
  const chainId = BigInt(input.token.chainId);
  return {
    token: {
      address: input.token.address,
      name: input.token.name,
      chainId,
      decimals: input.token.decimals,
      chainNamespace: isStellarChain(chainId) ? "stellar" : namespaceForChain(chainId)
    },
    amount: input.amount
  };
}

function toCoreCreateIntentOptions(opts: AppCreateIntentOptions): CreateIntentOptions {
  const account = opts.account();
  if (opts.verifier === "axelar") {
    for (const output of opts.outputTokens)
      axelarCorridor(opts.inputTokens[0].token.chainId, output.token.chainId);
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
  intentApi: IntentApi;

  walletClient: WC;
  apiQuoteContext?: () => ApiQuoteContext;
  apiQuoteSelection?: () => ApiQuoteSelection;

  preHook?: (chainId: number) => Promise<any>;
  postHook?: () => Promise<any>;

  orders: OrderContainer[] = [];

  constructor(options: {
    useProductionApi?: boolean | null;
    walletClient: WC;
    apiQuoteContext?: () => ApiQuoteContext;
    apiQuoteSelection?: () => ApiQuoteSelection;
    preHook?: (chainId: number) => Promise<any>;
    postHook?: () => Promise<any>;
    ordersPointer?: OrderContainer[];
  }) {
    const { useProductionApi, walletClient, preHook, postHook, ordersPointer } = options;
    this.intentApi = new IntentApi(resolveProductionApi(useProductionApi));
    this.walletClient = walletClient;
    this.apiQuoteContext = options.apiQuoteContext;
    this.apiQuoteSelection = options.apiQuoteSelection;

    this.preHook = preHook;
    this.postHook = postHook;

    if (ordersPointer) this.orders = ordersPointer;
  }

  async executeApiQuote(quote: SelectedApiQuote) {
    const getContext = this.apiQuoteContext;
    const getSelection = this.apiQuoteSelection;
    if (!getContext || !getSelection) throw new Error("Missing API quote selection context");
    const generation = getSelection().generation;
    const validateCurrentQuote = () => {
      const current = getSelection();
      if (current.quote !== quote || current.generation !== generation)
        throw new Error("API quote selection changed");
      return validateApiQuoteExecution(quote, getContext());
    };
    const context = getContext();
    const chainId = context.inputs[0].token.chainId;
    let validated = validateCurrentQuote();
    const tx = quote.order.openIntentTx;
    let hash: `0x${string}`;
    if (isStellarChain(chainId)) {
      const source = store.stellarAccounts[chainId];
      if (source !== context.user || !validated.scval)
        throw new Error("Stellar quote account changed");
      const receipt = await openStellarApiOrder(chainId, tx.to, validated.scval, source, () => {
        validateCurrentQuote();
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
        validated = validateCurrentQuote();
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
          validateCurrentQuote();
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
      const [currentAddress] = await this.walletClient.getAddresses();
      if (
        currentAddress?.toLowerCase() !== address.toLowerCase() ||
        (await this.walletClient.getChainId()) !== chainId
      )
        throw new Error("Quote wallet account/network changed before signing");
      validated = validateCurrentQuote();
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
      if (isTronChain(inputChain)) {
        throw new Error(
          "Compact intents are not supported for Tron — pending protocol decision on signing scheme"
        );
      }
      if (this.preHook) await this.preHook(inputChain);
      const intentInstance = new Intent(toCoreCreateIntentOptions(opts), intentDeps);
      applyIntentTimings(intentInstance);
      const intent = intentInstance.order();
      if (intent instanceof StandardSolanaIntent)
        throw new Error("Compact signing is not supported for Solana intents.");
      if (intent instanceof StandardStellarIntent)
        throw new Error("Stellar inputs only support escrow");

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
      applyIntentTimings(intentInstance2);
      const intent = intentInstance2.singlechain();
      if (intent instanceof StandardSolanaIntent)
        throw new Error("Compact deposit and register is not supported for Solana intents.");
      if (intent instanceof StandardStellarIntent)
        throw new Error("Stellar inputs only support escrow");
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
      applyIntentTimings(intentInstance3);
      const intent = intentInstance3.order();
      // Saved before the post-hook: a failed refresh must not lose an order
      // that is already open on-chain.
      if (intent instanceof StandardStellarIntent) {
        const open = await openStellarIntent(intent, store.stellarAccount);
        await this.saveOrder({ order: intent.asOrder(), inputSettler: intent.inputSettler });
        if (this.postHook) await this.postHook();
        return [open.hash];
      }

      const inputChain = inputTokens[0].token.chainId;
      if (this.preHook) await this.preHook(inputChain);

      // Execute the open.
      const transactionHashes = await openEscrowIntent(intent, account(), this.walletClient);
      console.log({ tsh: transactionHashes });
      // An EVM open is only broadcast at this point; wait for it, so the caller
      // keeps the order "in flight" (no second open) until it has landed.
      if (
        transactionHashes.length === 1 &&
        !isSolanaChain(inputChain) &&
        !isTronChain(inputChain) &&
        inputTokens.every(({ token }) => token.chainId === inputChain)
      ) {
        const receipt = await getClient(inputChain).waitForTransactionReceipt({
          hash: transactionHashes[0] as `0x${string}`
        });
        if (receipt.status !== "success") throw new Error("Open transaction reverted");
      }

      await this.saveOrder({
        order: intent.asOrder(),
        inputSettler: intent.inputSettler
      });

      if (this.postHook) await this.postHook();

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

      // Solana has no approval step at all: `open` debits the user's ATA under
      // the user's own signature, so there is nothing corresponding to an
      // ERC-20 allowance to set.
      if (isSolanaChain(token.chainId)) continue;

      if (isTronChain(token.chainId)) {
        // Native TRX inputs are attached as callValue on open — no approval.
        if (token.address.toLowerCase() === ADDRESS_ZERO) continue;
        const deps = { reads: await getTronReads(), signer: getTronSigner() };
        const tronAccount = store.tronConnectedAccount?.address;
        if (!tronAccount) throw new Error("TronLink is not connected");
        const currentTronAllowance = await getTrc20Allowance(
          deps.reads,
          token.address,
          tronAccount,
          TRON_MAINNET_INPUT_SETTLER
        );
        if (currentTronAllowance < amount) {
          await approveToken(deps, token.address, TRON_MAINNET_INPUT_SETTLER);
        }
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
