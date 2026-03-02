import { encodeAbiParameters, encodePacked, hashStruct, keccak256, parseAbiParameters } from "viem";
import type {
	BatchCompact,
	CompactMandate,
	Element,
	MandateOutput,
	MultichainCompact,
	MultichainOrder,
	MultichainOrderComponent,
	NoSignature,
	Signature,
	StandardOrder
} from "../../types";
import { COMPACT_ABI } from "../abi/compact";
import {
	chainMap,
	clients,
	COIN_FILLER,
	COMPACT,
	getChainName,
	getOracle,
	INPUT_SETTLER_COMPACT_LIFI,
	INPUT_SETTLER_ESCROW_LIFI,
	MULTICHAIN_INPUT_SETTLER_COMPACT,
	MULTICHAIN_INPUT_SETTLER_ESCROW,
	type chain,
	type Verifier,
	type WC
} from "../config";
import { ResetPeriod, toId } from "../utils/idLib";
import { compact_type_hash, compactTypes } from "../utils/typedMessage";
import { addressToBytes32 } from "../utils/convert";
import { SETTLER_ESCROW_ABI } from "../abi/escrow";
import type { TokenContext } from "$lib/state.svelte";
import { MULTICHAIN_SETTLER_ESCROW_ABI } from "$lib/abi/multichain_escrow";
import { SETTLER_COMPACT_ABI } from "$lib/abi/settlercompact";
import { toHex } from "$lib/utils/interopableAddresses";
import { MULTICHAIN_SETTLER_COMPACT_ABI } from "$lib/abi/multichain_compact";

type Lock = {
	lockTag: `0x${string}`;
	token: `0x${string}`;
	amount: bigint;
};

export type EscrowLock = {
	type: "escrow";
};

export type CompactLock = {
	type: "compact";
	resetPeriod: ResetPeriod;
	allocatorId: string;
};

export type CreateIntentOptionsEscrow = {
	recipient: string;
	exclusiveFor: string;
	inputTokens: TokenContext[];
	outputTokens: TokenContext[];
	verifier: Verifier;
	account: () => `0x${string}`;
	lock: EscrowLock;
};

export type CreateIntentOptionsCompact = {
	recipient: string;
	exclusiveFor: string;
	inputTokens: TokenContext[];
	outputTokens: TokenContext[];
	verifier: Verifier;
	account: () => `0x${string}`;
	lock: CompactLock;
};

export type CreateIntentOptions = CreateIntentOptionsEscrow | CreateIntentOptionsCompact;

function findChain(chainId: bigint) {
	for (const [name, data] of Object.entries(chainMap)) {
		if (BigInt(data.id) === chainId) {
			return chainMap[name as chain];
		}
	}
	return undefined;
}

function selectAllBut<T>(arr: T[], index: number): T[] {
	return [...arr.slice(0, index), ...arr.slice(index + 1, arr.length)];
}

function encodeOutputs(outputs: MandateOutput[]) {
	return encodeAbiParameters(
		parseAbiParameters(
			"(bytes32 oracle, bytes32 settler, uint256 chainId, bytes32 token, uint256 amount, bytes32 recipient, bytes callbackData, bytes context)[]"
		),
		[outputs]
	);
}

const ONE_MINUTE = 60;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;

/**
 * @notice Class representing a Li.Fi Intent. Contains intent abstractions and helpers.
 */
export class Intent {
	private lock: EscrowLock | CompactLock;

	// User facing order options
	private user: () => `0x${string}`;
	private recipient: `0x${string}`;
	private inputs: TokenContext[];
	private outputs: TokenContext[];
	private verifier: Verifier;

	private exclusiveFor?: `0x${string}`;

	private _nonce?: bigint;

	private expiry = ONE_DAY;
	private fillDeadline = 2 * ONE_HOUR;

	constructor(opts: CreateIntentOptionsEscrow | CreateIntentOptionsCompact) {
		this.lock = opts.lock;

		this.user = opts.account;
		this.recipient = this.normalizeRecipient(opts.recipient);
		this.inputs = opts.inputTokens;
		this.outputs = opts.outputTokens;
		this.verifier = opts.verifier;

		this.exclusiveFor = this.normalizeExclusiveFor(opts.exclusiveFor);
	}

	private normalizeRecipient(recipient: string): `0x${string}` {
		const trimmed = recipient.trim();
		const normalized = trimmed.toLowerCase();
		if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
			throw new Error(`Recipient not formatted correctly: ${recipient}`);
		}
		return normalized as `0x${string}`;
	}

	private normalizeExclusiveFor(exclusiveFor: string): `0x${string}` | undefined {
		const trimmed = exclusiveFor.trim();
		if (trimmed.length === 0) return undefined;
		const normalized = trimmed.toLowerCase();
		if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
			throw new Error(`ExclusiveFor not formatted correctly ${exclusiveFor}`);
		}
		return normalized as `0x${string}`;
	}

	numInputChains() {
		const tokenChains = this.inputs.map(({ token }) => token.chain);
		return [...new Set(tokenChains)].length;
	}

	isMultichain() {
		return this.numInputChains() > 1;
	}

	isSameChain() {
		// Multichain intents cannot be same chain. Normal "Output oracle" will be used.
		if (this.isMultichain()) return false;

		// Only 1 input chain is used.
		const inputChain = this.inputs[0].token.chain;
		const outputChains = this.outputs.map((o) => o.token.chain);
		const numOutputChains = [...new Set(outputChains)].length;
		if (numOutputChains > 1) return false;
		// Only 1 output chain is used.
		const outputChain = this.outputs[0].token.chain;
		return inputChain === outputChain;
	}

	nonce() {
		if (this._nonce) return this._nonce;
		this._nonce = BigInt(Math.floor(Math.random() * 2 ** 32));
		return this._nonce;
	}

	inputSettler(multichain: boolean) {
		if (this.lock.type === "compact" && multichain === false) return INPUT_SETTLER_COMPACT_LIFI;
		if (this.lock.type === "compact" && multichain === true)
			return MULTICHAIN_INPUT_SETTLER_COMPACT;
		if (this.lock.type === "escrow" && multichain === false) return INPUT_SETTLER_ESCROW_LIFI;
		if (this.lock.type === "escrow" && multichain === true) return MULTICHAIN_INPUT_SETTLER_ESCROW;

		throw new Error(`Not supported | multichain: ${multichain}, type: ${this.lock.type}`);
	}

	encodeOutputs(currentTime: number) {
		// Get the current epoch timestamp:
		currentTime;
		const ONE_MINUTE = 60;

		let context: `0x${string}` = "0x";
		if (this.exclusiveFor) {
			const paddedExclusiveFor: `0x${string}` = `0x${this.exclusiveFor.replace("0x", "").padStart(64, "0")}`;
			context = encodePacked(
				["bytes1", "bytes32", "uint32"],
				["0xe0", paddedExclusiveFor, currentTime + ONE_MINUTE]
			);
		}

		const outputSettler = COIN_FILLER;
		const sameChain = this.isSameChain();

		return this.outputs.map(({ token, amount }) => {
			const outputOracle = sameChain
				? addressToBytes32(outputSettler)
				: addressToBytes32(getOracle(this.verifier, token.chain)!);
			return {
				oracle: outputOracle,
				settler: addressToBytes32(outputSettler),
				chainId: BigInt(chainMap[token.chain].id),
				token: addressToBytes32(token.address),
				amount: amount,
				recipient: addressToBytes32(this.recipient),
				callbackData: "0x",
				context
			};
		}) as MandateOutput[];
	}

	singlechain() {
		if (this.isMultichain())
			throw new Error(`Not supported as single chain with ${this.numInputChains()} chains`);

		const inputChain = this.inputs[0].token.chain;

		const inputs: [bigint, bigint][] = this.inputs.map(({ token, amount }) => [
			this.lock.type === "compact"
				? toId(true, this.lock.resetPeriod, this.lock.allocatorId, token.address)
				: BigInt(token.address),
			amount
		]);

		const currentTime = Math.floor(Date.now() / 1000);

		const inputOracle = this.isSameChain() ? COIN_FILLER : getOracle(this.verifier, inputChain)!;

		const order: StandardOrder = {
			user: this.user(),
			nonce: this.nonce(),
			originChainId: BigInt(chainMap[inputChain].id),
			fillDeadline: currentTime + this.fillDeadline,
			expires: currentTime + this.expiry,
			inputOracle: inputOracle,
			inputs: inputs,
			outputs: this.encodeOutputs(currentTime)
		};

		return new StandardOrderIntent(this.inputSettler(false), order);
	}

	multichain() {
		const currentTime = Math.floor(Date.now() / 1000);

		// TODO: Fix before release. The input oracle is not the same on every chain.
		const inputOracle = getOracle(this.verifier, this.inputs[0].token.chain)!;

		// Get all unique chains and then get all inputs for each chain.
		const inputs: { chainId: bigint; inputs: [bigint, bigint][] }[] = [
			...new Set(this.inputs.map(({ token }) => token.chain))
		].map((chain) => {
			const chainInputs = this.inputs.filter(({ token }) => token.chain === chain);

			return {
				chainId: BigInt(chainMap[chain].id),
				inputs: chainInputs.map(({ token, amount }) => [
					this.lock.type === "compact"
						? toId(true, this.lock.resetPeriod, this.lock.allocatorId, token.address)
						: BigInt(token.address),
					amount
				])
			};
		});

		const order: MultichainOrder = {
			user: this.user(),
			nonce: this.nonce(),
			fillDeadline: currentTime + this.fillDeadline,
			expires: currentTime + this.expiry,
			inputOracle: inputOracle,
			outputs: this.encodeOutputs(currentTime),
			inputs: inputs
		};

		return new MultichainOrderIntent(this.inputSettler(true), order, this.lock);
	}

	order() {
		if (this.isMultichain()) return this.multichain();
		return this.singlechain();
	}
}

/// @notice Helper function that allows you to provide an order and it will correctly generate the appropriate order.
export function orderToIntent(options: {
	inputSettler: `0x${string}`;
	order: StandardOrder;
	lock?: { type: string };
}): StandardOrderIntent;
export function orderToIntent(options: {
	inputSettler: `0x${string}`;
	order: MultichainOrder;
	lock?: { type: string };
}): MultichainOrderIntent;
export function orderToIntent(options: {
	inputSettler: `0x${string}`;
	order: StandardOrder | MultichainOrder;
	lock?: { type: string };
}): StandardOrderIntent | MultichainOrderIntent;
export function orderToIntent(options: {
	inputSettler: `0x${string}`;
	order: StandardOrder | MultichainOrder;
	lock?: { type: string };
}): StandardOrderIntent | MultichainOrderIntent {
	const { inputSettler, order, lock } = options;
	// Use presence of originChainId to discriminate StandardOrder vs MultichainOrder
	if ("originChainId" in order) {
		return new StandardOrderIntent(inputSettler, order as StandardOrder);
	}
	return new MultichainOrderIntent(inputSettler, order as MultichainOrder, lock);
}

export class StandardOrderIntent {
	inputSettler: `0x${string}`;
	order: StandardOrder;

	constructor(inputSetter: `0x${string}`, order: StandardOrder) {
		this.inputSettler = inputSetter;
		this.order = order;
	}

	// -- Order Representations -- //

	/**
	 * @notice Returns for logging
	 */
	asOrder(): StandardOrder {
		return this.order;
	}

	/**
	 * @notice Returns the order as a StandardOrder.
	 * @returns Order as StandardOrder
	 */
	asStandardOrder(): StandardOrder {
		return this.order;
	}

	/**
	 * @notice Returns the order as a BatchCompact.
	 * @returns Order as BatchCompact (signed object for Compact)
	 */
	asBatchCompact(): BatchCompact {
		const { order } = this;
		const mandate: CompactMandate = {
			fillDeadline: order.fillDeadline,
			inputOracle: order.inputOracle,
			outputs: order.outputs
		};
		const commitments = order.inputs.map(([tokenId, amount]) => {
			const lockTag: `0x${string}` = `0x${toHex(tokenId, 32).slice(0, 12 * 2)}`;
			const token: `0x${string}` = `0x${toHex(tokenId, 32).slice(12 * 2, 32 * 2)}`;
			return {
				lockTag,
				token,
				amount
			};
		});
		return {
			arbiter: INPUT_SETTLER_COMPACT_LIFI,
			sponsor: order.user,
			nonce: order.nonce,
			expires: BigInt(order.expires),
			commitments,
			mandate
		};
	}

	inputChains(): bigint[] {
		return [this.order.originChainId];
	}

	orderId(): `0x${string}` {
		return keccak256(
			encodePacked(
				[
					"uint256",
					"address",
					"address",
					"uint256",
					"uint32",
					"uint32",
					"address",
					"bytes32",
					"bytes"
				],
				[
					this.order.originChainId,
					this.inputSettler,
					this.order.user,
					this.order.nonce,
					this.order.expires,
					this.order.fillDeadline,
					this.order.inputOracle,
					keccak256(encodePacked(["uint256[2][]"], [this.order.inputs])),
					encodeOutputs(this.order.outputs)
				]
			)
		);
	}

	// -- Escrow Helpers -- //

	/**
	 * @notice Opens an intent using the escrow input settler by depositing into it.
	 * @param account Account that calls open.
	 * @param walletClient Wallet client for sending the call to.
	 * @returns transactionHash for the on-chain call.
	 */
	async openEscrow(account: `0x${string}`, walletClient: WC): Promise<[`0x${string}`]> {
		const chain = findChain(this.order.originChainId);
		walletClient.switchChain({ id: Number(this.order.originChainId) });
		if (!chain)
			throw new Error("Chain not found for chainId " + this.order.originChainId.toString());
		return [
			await walletClient.writeContract({
				chain,
				account,
				address: INPUT_SETTLER_ESCROW_LIFI,
				abi: SETTLER_ESCROW_ABI,
				functionName: "open",
				args: [this.order]
			})
		];
	}

	// -- Compact Helpers -- //

	compactClaimHash(): `0x${string}` {
		const claimHash = hashStruct({
			data: this.asBatchCompact(),
			types: compactTypes,
			primaryType: "BatchCompact"
		});
		return claimHash;
	}

	signCompact(account: `0x${string}`, walletClient: WC): Promise<`0x${string}`> {
		const chainId = this.order.originChainId;
		return walletClient.signTypedData({
			account,
			domain: {
				name: "The Compact",
				version: "1",
				chainId,
				verifyingContract: COMPACT
			} as const,
			types: compactTypes,
			primaryType: "BatchCompact",
			message: this.asBatchCompact()
		});
	}

	depositAndRegisterCompact(account: `0x${string}`, walletClient: WC): Promise<`0x${string}`> {
		const chain = findChain(this.order.originChainId);
		if (!chain)
			throw new Error("Chain not found for chainId " + this.order.originChainId.toString());
		return walletClient.writeContract({
			chain,
			account,
			address: COMPACT,
			abi: COMPACT_ABI,
			functionName: "batchDepositAndRegisterMultiple",
			args: [this.order.inputs, [[this.compactClaimHash(), compact_type_hash]]]
		});
	}

	async finalise(options: {
		sourceChain: chain;
		account: `0x${string}`;
		walletClient: WC;
		solveParams: { timestamp: number; solver: `0x${string}` }[];
		signatures: {
			sponsorSignature: Signature | NoSignature;
			allocatorSignature: Signature | NoSignature;
		};
	}) {
		const { sourceChain, account, walletClient, solveParams, signatures } = options;
		const actionChain = chainMap[sourceChain];
		if (actionChain.id !== Number(this.order.originChainId))
			throw new Error(
				`Origin chain id and action ID does not match: ${this.order.originChainId}, ${actionChain.id}`
			);

		if (this.inputSettler.toLowerCase() === INPUT_SETTLER_ESCROW_LIFI.toLowerCase()) {
			return await walletClient.writeContract({
				chain: actionChain,
				account: account,
				address: this.inputSettler,
				abi: SETTLER_ESCROW_ABI,
				functionName: "finalise",
				args: [this.order, solveParams, addressToBytes32(account), "0x"]
			});
		} else if (this.inputSettler.toLowerCase() === INPUT_SETTLER_COMPACT_LIFI.toLowerCase()) {
			// Check whether or not we have a signature.
			const { sponsorSignature, allocatorSignature } = signatures;
			console.log({
				sponsorSignature,
				allocatorSignature
			});
			const combinedSignatures = encodeAbiParameters(parseAbiParameters(["bytes", "bytes"]), [
				sponsorSignature.payload ?? "0x",
				allocatorSignature.payload
			]);
			return await walletClient.writeContract({
				chain: actionChain,
				account: account,
				address: this.inputSettler,
				abi: SETTLER_COMPACT_ABI,
				functionName: "finalise",
				args: [this.order, combinedSignatures, solveParams, addressToBytes32(account), "0x"]
			});
		} else {
			throw new Error(`Could not detect settler type ${this.inputSettler}`);
		}
	}
}

export class MultichainOrderIntent {
	lock?: { type: string } | EscrowLock | CompactLock;

	// Notice that this has to be the same address on every chain.
	inputSettler: `0x${string}`;
	order: MultichainOrder;

	constructor(inputSetter: `0x${string}`, order: MultichainOrder, lock?: { type: string }) {
		this.inputSettler = inputSetter;
		this.order = order;

		const isCompact =
			this.inputSettler === INPUT_SETTLER_COMPACT_LIFI ||
			this.inputSettler === MULTICHAIN_INPUT_SETTLER_COMPACT;

		this.lock = lock ?? { type: isCompact ? "compact" : "escrow" };
	}

	selfTest() {
		this.asOrder();
		this.inputChains();
		this.asComponents();

		this.orderId();
	}

	/**
	 * @notice Returns for logging
	 */
	asOrder(): MultichainOrder {
		return this.order;
	}

	inputChains(): bigint[] {
		return [...new Set(this.order.inputs.map((i) => i.chainId))];
	}

	orderId(): `0x${string}` {
		// We need a random order components.
		const components = this.asComponents();
		const computedOrderIds = components.map((c) =>
			this.lock?.type === "escrow"
				? MultichainOrderIntent.escrowOrderId(this.inputSettler, c.orderComponent, c.chainId)
				: MultichainOrderIntent.compactOrderid(this.inputSettler, c.orderComponent, c.chainId)
		);

		const orderId = computedOrderIds[0];
		computedOrderIds.map((v) => {
			if (v !== orderId) throw new Error(`Order ids are not equal ${computedOrderIds}`);
		});
		if (this.lock?.type === "compact") {
			const multichainCompactHash = hashStruct({
				data: this.asMultichainBatchCompact(),
				types: compactTypes,
				primaryType: "MultichainCompact"
			});
			if (multichainCompactHash !== orderId)
				throw new Error(
					`MultichainCompact does not match orderId, ${multichainCompactHash} ${orderId}`
				);
		}
		return orderId;
	}

	async orderIdCheck() {
		const components = this.asComponents();
		const computedOrderId = this.orderId();
		const onChainOrderIds = await Promise.all(
			components.map(async (component) => {
				const onChainId = await clients[getChainName(component.chainId)].readContract({
					address: this.inputSettler,
					abi: MULTICHAIN_SETTLER_COMPACT_ABI,
					functionName: "orderIdentifier",
					args: [component.orderComponent]
				});
				return onChainId;
			})
		);
		console.log({ computedOrderId, onChainOrderIds });
	}

	static escrowOrderId(
		inputSettler: `0x${string}`,
		orderComponent: MultichainOrderComponent,
		_: bigint
	) {
		return keccak256(
			encodePacked(
				["address", "address", "uint256", "uint32", "uint32", "address", "bytes32", "bytes"],
				[
					inputSettler,
					orderComponent.user,
					orderComponent.nonce,
					orderComponent.expires,
					orderComponent.fillDeadline,
					orderComponent.inputOracle,
					MultichainOrderIntent.constructInputHash(
						orderComponent.chainIdField,
						orderComponent.chainIndex,
						orderComponent.inputs,
						orderComponent.additionalChains
					),
					encodeOutputs(orderComponent.outputs)
				]
			)
		);
	}

	static compactOrderid(
		inputSettler: `0x${string}`,
		orderComponent: MultichainOrderComponent,
		chainId: bigint
	) {
		const MULTICHAIN_COMPACT_TYPEHASH_WITH_WITNESS = keccak256(
			encodePacked(
				["string"],
				[
					"MultichainCompact(address sponsor,uint256 nonce,uint256 expires,Element[] elements)Element(address arbiter,uint256 chainId,Lock[] commitments,Mandate mandate)Lock(bytes12 lockTag,address token,uint256 amount)Mandate(uint32 fillDeadline,address inputOracle,MandateOutput[] outputs)MandateOutput(bytes32 oracle,bytes32 settler,uint256 chainId,bytes32 token,uint256 amount,bytes32 recipient,bytes callbackData,bytes context)"
				]
			)
		);
		const { fillDeadline, inputOracle, outputs, inputs } = orderComponent;
		const mandate: CompactMandate = {
			fillDeadline,
			inputOracle,
			outputs
		};
		const element: Element = {
			arbiter: inputSettler,
			chainId: chainId,
			commitments: MultichainOrderIntent.inputsToLocks(inputs),
			mandate
		};

		const elementHash = hashStruct({
			types: compactTypes,
			primaryType: "Element",
			data: element
		});

		const elementHashes = [
			...orderComponent.additionalChains.slice(0, Number(orderComponent.chainIndex)),
			elementHash,
			...orderComponent.additionalChains.slice(Number(orderComponent.chainIndex))
		];

		return keccak256(
			encodeAbiParameters(
				parseAbiParameters(["bytes32", "address", "uint256", "uint256", "bytes32"]),
				[
					MULTICHAIN_COMPACT_TYPEHASH_WITH_WITNESS,
					orderComponent.user,
					orderComponent.nonce,
					BigInt(orderComponent.expires),
					keccak256(encodePacked(["bytes32[]"], [elementHashes]))
				]
			)
		);
	}

	static hashInputs(chainId: bigint, inputs: [bigint, bigint][]) {
		return keccak256(encodePacked(["uint256", "uint256[2][]"], [chainId, inputs]));
	}

	static constructInputHash(
		inputsChainId: bigint,
		chainIndex: bigint,
		inputs: [bigint, bigint][],
		additionalChains: `0x${string}`[]
	) {
		const inputHash = MultichainOrderIntent.hashInputs(inputsChainId, inputs);
		const numSegments = additionalChains.length + 1;
		if (numSegments <= chainIndex)
			throw new Error(`ChainIndexOutOfRange(${chainIndex},${numSegments})`);
		const claimStructure: `0x${string}`[] = [];
		for (let i = 0; i < numSegments; ++i) {
			const additionalChainsIndex = i > chainIndex ? i - 1 : i;
			const inputHashElement =
				chainIndex == BigInt(i) ? inputHash : additionalChains[additionalChainsIndex];
			claimStructure[i] = inputHashElement;
		}
		return keccak256(encodePacked(["bytes32[]"], [claimStructure]));
	}

	static inputsToLocks(inputs: [bigint, bigint][]): Lock[] {
		return inputs.map((input) => {
			const bytes32 = toHex(input[0], 32);
			return {
				lockTag: `0x${bytes32.slice(0, 12 * 2)}`,
				token: `0x${bytes32.slice(12 * 2, 32 * 2)}`,
				amount: input[1]
			};
		});
	}

	secondariesEcsrow(): { chainIdField: bigint; additionalChains: `0x${string}`[] }[] {
		const inputsHash: `0x${string}`[] = this.order.inputs.map((input) =>
			keccak256(encodePacked(["uint256", "uint256[2][]"], [input.chainId, input.inputs]))
		);
		return this.order.inputs.map((v, i) => {
			return {
				chainIdField: v.chainId,
				additionalChains: selectAllBut(inputsHash, i)
			};
		});
	}

	asCompactElements() {
		const { fillDeadline, inputOracle, outputs, inputs } = this.order;
		const mandate: CompactMandate = {
			fillDeadline,
			inputOracle,
			outputs
		};
		return inputs.map((inputs) => {
			const element: Element = {
				arbiter: this.inputSettler,
				chainId: inputs.chainId,
				commitments: MultichainOrderIntent.inputsToLocks(inputs.inputs),
				mandate
			};
			return element;
		});
	}

	secondariesCompact(): { chainIdField: bigint; additionalChains: `0x${string}`[] }[] {
		const { inputs } = this.order;
		const elements = this.asCompactElements().map((element) => {
			const hash = hashStruct({
				types: compactTypes,
				primaryType: "Element",
				data: element
			});
			return hash;
		});
		return inputs.map((_, i) => {
			return {
				chainIdField: inputs[0].chainId,
				additionalChains: selectAllBut(elements, i)
			};
		});
	}

	asComponents(): { chainId: bigint; orderComponent: MultichainOrderComponent }[] {
		const { inputs, user, nonce, expires, fillDeadline, inputOracle, outputs } = this.order;
		if (!this.lock) throw new Error(`No lock provided, cannot compute secondaries.`);
		const secondaries =
			this.lock.type == "escrow" ? this.secondariesEcsrow() : this.secondariesCompact();
		const components: { chainId: bigint; orderComponent: MultichainOrderComponent }[] = [];
		for (let i = 0; i < inputs.length; ++i) {
			const { chainIdField, additionalChains } = secondaries[i];

			const orderComponent: MultichainOrderComponent = {
				user: user,
				nonce: nonce,
				chainIdField: chainIdField,
				chainIndex: BigInt(i),
				expires: expires,
				fillDeadline: fillDeadline,
				inputOracle: inputOracle,
				inputs: inputs[i].inputs,
				outputs: outputs,
				additionalChains: additionalChains
			};
			components.push({ chainId: inputs[i].chainId, orderComponent });
		}
		return components;
	}

	// -- Compact Helpers -- //

	asMultichainBatchCompact(): MultichainCompact {
		const { order } = this;
		const mandate: CompactMandate = {
			fillDeadline: order.fillDeadline,
			inputOracle: order.inputOracle,
			outputs: order.outputs
		};
		const result = {
			sponsor: order.user,
			nonce: order.nonce,
			expires: BigInt(order.expires),
			elements: this.asCompactElements(),
			mandate
		};
		return result;
	}

	compactClaimHash(): `0x${string}` {
		const claimHash = hashStruct({
			data: this.asMultichainBatchCompact(),
			types: compactTypes,
			primaryType: "MultichainCompact"
		});
		return claimHash;
	}

	signCompact(account: `0x${string}`, walletClient: WC): Promise<`0x${string}`> {
		this.selfTest();
		const chainId = this.order.inputs[0].chainId;
		return walletClient.signTypedData({
			account,
			domain: {
				name: "The Compact",
				version: "1",
				chainId,
				verifyingContract: COMPACT
			} as const,
			types: compactTypes,
			primaryType: "MultichainCompact",
			message: this.asMultichainBatchCompact()
		});
	}

	// This code is depreciated and needs to be updated.
	async openEscrow(account: `0x${string}`, walletClient: WC) {
		this.selfTest();
		const components = this.asComponents();
		const results: `0x${string}`[] = [];
		for (const { chainId, orderComponent } of components) {
			const chain = findChain(chainId)!;
			walletClient.switchChain({ id: chain.id });
			results.push(
				await walletClient.writeContract({
					chain,
					account,
					address: this.inputSettler,
					abi: MULTICHAIN_SETTLER_ESCROW_ABI,
					functionName: "open",
					args: [orderComponent]
				})
			);
			console.log(results);
		}
		return results;
	}

	async finalise(options: {
		sourceChain: chain;
		account: `0x${string}`;
		walletClient: WC;
		solveParams: { timestamp: number; solver: `0x${string}` }[];
		signatures: {
			sponsorSignature: Signature | NoSignature;
			allocatorSignature: Signature | NoSignature;
		};
	}) {
		this.asMultichainBatchCompact();
		const { sourceChain, account, walletClient, solveParams, signatures } = options;
		const actionChain = chainMap[sourceChain];
		const inputChainIds = this.inputChains().map((v) => Number(v));
		if (!inputChainIds.includes(actionChain.id))
			throw new Error(
				`Action chain must be one of input chains for finalise: ${inputChainIds}, action=${actionChain.id}`
			);
		// Get all components for our chain.
		const components = this.asComponents().filter((c) => Number(c.chainId) === actionChain.id);
		if (components.length === 0) {
			throw new Error(
				`No multichain order component found for action chain ${actionChain.id} (${sourceChain}).`
			);
		}

		for (const { orderComponent, chainId } of components) {
			if (this.inputSettler.toLowerCase() === MULTICHAIN_INPUT_SETTLER_ESCROW.toLowerCase()) {
				return await walletClient.writeContract({
					chain: actionChain,
					account: account,
					address: this.inputSettler,
					abi: MULTICHAIN_SETTLER_ESCROW_ABI,
					functionName: "finalise",
					args: [orderComponent, solveParams, addressToBytes32(account), "0x"]
				});
			} else if (
				this.inputSettler.toLowerCase() === MULTICHAIN_INPUT_SETTLER_COMPACT.toLowerCase()
			) {
				const { sponsorSignature, allocatorSignature } = signatures;
				console.log({
					orderComponent,
					sponsorSignature,
					allocatorSignature
				});

				const combinedSignatures = encodeAbiParameters(parseAbiParameters(["bytes", "bytes"]), [
					sponsorSignature.payload ?? "0x",
					allocatorSignature.payload
				]);
				return await walletClient.writeContract({
					chain: actionChain,
					account: account,
					address: this.inputSettler,
					abi: MULTICHAIN_SETTLER_COMPACT_ABI,
					functionName: "finalise",
					args: [orderComponent, combinedSignatures, solveParams, addressToBytes32(account), "0x"]
				});
			} else {
				throw new Error(`Could not detect settler type ${this.inputSettler}`);
			}
		}
		throw new Error(`Failed to finalise multichain order on chain ${sourceChain}.`);
	}
}
