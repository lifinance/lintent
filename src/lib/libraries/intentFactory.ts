import {
	chainMap,
	getChain,
	getClient,
	INPUT_SETTLER_COMPACT_LIFI,
	INPUT_SETTLER_ESCROW_LIFI,
	MULTICHAIN_INPUT_SETTLER_ESCROW,
	SOLANA_INPUT_SETTLER_ESCROW,
	solanaDevnetConnection,
	type WC
} from "$lib/config";
import solanaWallet from "$lib/utils/solana-wallet.svelte";
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
import type { AppCreateIntentOptions, AppTokenContext } from "$lib/appTypes";
import { ERC20_ABI } from "$lib/abi/erc20";
import { Intent, IntentApi, SolanaIntent, solanaOrderToStandardOrder } from "@lifi/intent";
import { store } from "$lib/state.svelte";
import { depositAndRegisterCompact, openEscrowIntent, signIntentCompact } from "./intentExecution";
import { intentDeps, solanaDeps } from "./coreDeps";
import { solanaAddressToBytes32 } from "$lib/utils/solana";
import { openSolanaEscrow } from "./solanaEscrowLib";

function toCoreTokenContext(input: AppTokenContext): TokenContext {
	return {
		token: {
			address: input.token.address,
			name: input.token.name,
			chainId: BigInt(input.token.chainId),
			decimals: input.token.decimals
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
		walletClient: WC;
		preHook?: (chainId: number) => Promise<any>;
		postHook?: () => Promise<any>;
		ordersPointer?: OrderContainer[];
	}) {
		const { mainnet, walletClient, preHook, postHook, ordersPointer } = options;
		this.mainnet = mainnet;
		this.intentApi = new IntentApi(mainnet);
		this.walletClient = walletClient;

		this.preHook = preHook;
		this.postHook = postHook;

		if (ordersPointer) this.orders = ordersPointer;
	}

	private saveOrder(options: {
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
		store.saveOrderToDb(orderContainer).catch((e) => console.warn("saveOrderToDb error", e));
	}

	compact(opts: AppCreateIntentOptions) {
		return async () => {
			const { account, inputTokens } = opts;
			const inputChain = inputTokens[0].token.chainId;
			if (this.preHook) await this.preHook(inputChain);
			const intent = new Intent(toCoreCreateIntentOptions(opts), intentDeps).order();

			const sponsorSignature = await signIntentCompact(intent, account(), this.walletClient);

			console.log({
				order: intent.asOrder(),
				sponsorSignature
			});

			this.saveOrder({
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
			const intent = new Intent(toCoreCreateIntentOptions(opts), intentDeps).singlechain();

			if (this.preHook) await this.preHook(inputTokens[0].token.chainId);

			let transactionHash = await depositAndRegisterCompact(intent, account(), this.walletClient);

			const receipt = await getClient(inputTokens[0].token.chainId).waitForTransactionReceipt({
				hash: transactionHash
			});

			// If you use another allocator than polymer, there should be logic for potentially getting the allocator signature here.
			// You may consider getting the allocator signature before you call depositAndRegisterCompact

			// Add the order to our local order list.
			this.saveOrder({
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
			const { inputTokens, outputTokens, account } = opts;
			const inputChain = inputTokens[0].token.chainId;

			let transactionHashes: string[];

			if (inputChain === chainMap.solanaDevnet.id) {
				if (!solanaWallet.adapter || !solanaWallet.publicKey) {
					throw new Error("Solana wallet not connected");
				}
				const solanaOrderIntent = new SolanaIntent(
					{
						account: solanaAddressToBytes32(solanaWallet.publicKey),
						inputToken: toCoreTokenContext(inputTokens[0]),
						outputTokens: outputTokens.map(toCoreTokenContext),
						verifier: opts.verifier,
						exclusiveFor: opts.exclusiveFor
					},
					solanaDeps
				).order();
				transactionHashes = [
					await openSolanaEscrow({
						order: solanaOrderIntent.asOrder(),
						solanaPublicKey: solanaWallet.publicKey,
						walletAdapter: solanaWallet.adapter,
						connection: solanaDevnetConnection
					})
				];
				this.saveOrder({
					order: solanaOrderToStandardOrder(solanaOrderIntent.asOrder()),
					inputSettler: solanaAddressToBytes32(SOLANA_INPUT_SETTLER_ESCROW)
				});
			} else {
				if (this.preHook) await this.preHook(inputChain);
				const intent = new Intent(toCoreCreateIntentOptions(opts), intentDeps).order();
				transactionHashes = await openEscrowIntent(intent, account(), this.walletClient);
				this.saveOrder({
					order: intent.asOrder(),
					inputSettler: store.inputSettler
				});
			}

			console.log({ tsh: transactionHashes });

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
