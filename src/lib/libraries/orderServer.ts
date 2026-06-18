import axios from "axios";
import type {
	MultichainOrder,
	NoSignature,
	OrderContainer,
	Quote,
	Signature,
	StandardOrder
} from "../../types";
import { type chain, chainMap } from "$lib/config";
import { getInteropableAddress } from "../utils/interopableAddresses";

type OrderStatus = "Signed" | "Delivered" | "Settled";

type SubmitOrderDto = {
	orderType: "CatalystCompactOrder";
	order: StandardOrder;
	inputSettler: `0x${string}`;
	sponsorSignature?: `0x${string}`;
	allocatorSignature?: `0x${string}`;
	compactRegistrationTxHash?: `0x${string}`;
};

type orderPush = (orderArr: {
	order: StandardOrder;
	inputSettler: `0x${string}`;
	sponsorSignature?: `0x${string}`;
	allocatorSignature?: `0x${string}`;
}) => void;

type GetOrderResponse = {
	data: {
		order: StandardOrder;
		quote: Quote;
		sponsorSignature: `0x${string}` | null;
		allocatorSignature?: `0x${string}` | null;
		inputSettler: `0x${string}`;
		meta: {
			submitTime: number;
			orderStatus: OrderStatus;
			destinationAddress: `0x${string}`;
			orderIdentifier: string;
			onChainOrderId: `0x${string}`;
			signedAt: string;
			expiredAt: string | null;
		};
	}[];
	meta: {
		limit: number;
		offset: number;
		total: number;
	};
};

type GetQuoteOptions = {
	user: `0x${string}`;
	userChain: chain;
	inputs: {
		sender: `0x${string}`;
		asset: `0x${string}`;
		chain: chain;
		amount: bigint;
	}[];
	outputs: {
		receiver: `0x${string}`;
		asset: `0x${string}`;
		chain: chain;
		amount: bigint;
	}[];
	minValidUntil?: number;
	exclusiveFor?: `0x${string}`[];
};

type GetQuoteResponse = {
	quotes: {
		order: null;
		eta: null;
		validUntil: null;
		quoteId: null;
		metadata: {
			exclusiveFor: `0x${string}` | `0x${string}`[];
		};
		preview: {
			inputs: {
				user: `0x${string}`;
				asset: `0x${string}`;
				amount: string;
			}[];
			outputs: {
				receiver: `0x${string}`;
				asset: `0x${string}`;
				amount: string;
			}[];
		};
		provider: null;
		partialFill: false;
		failureHandling: "refund-automatic";
	}[];
};

function normalizeHexAddress<T extends `0x${string}`>(value: T): T {
	return value.toLowerCase() as T;
}

type OrderEnvelope = {
	order: unknown;
	inputSettler: unknown;
	sponsorSignature?: unknown;
	allocatorSignature?: unknown;
};

function toHexString(value: unknown, field: string): `0x${string}` {
	if (typeof value !== "string" || !value.startsWith("0x")) {
		throw new Error(`Order payload invalid: ${field}`);
	}
	return value as `0x${string}`;
}

function toBigIntValue(value: unknown, field: string): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
	if (typeof value === "string" && value.length > 0) return BigInt(value);
	throw new Error(`Order payload invalid: ${field}`);
}

function toNumberValue(value: unknown, field: string): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string" && value.length > 0) return Number(value);
	throw new Error(`Order payload invalid: ${field}`);
}

function normalizeSignature(value: unknown): Signature | NoSignature {
	if (!value) return { type: "None", payload: "0x" };
	return {
		type: "ECDSA",
		payload: toHexString(value, "signature")
	};
}

function normalizeOutputs(value: unknown) {
	if (!Array.isArray(value)) throw new Error("Order payload invalid: outputs");
	return value.map((output, index) => {
		if (!output || typeof output !== "object") {
			throw new Error(`Order payload invalid: outputs[${index}]`);
		}
		const o = output as Record<string, unknown>;
		return {
			oracle: toHexString(o.oracle, `outputs[${index}].oracle`),
			settler: toHexString(o.settler, `outputs[${index}].settler`),
			chainId: toBigIntValue(o.chainId, `outputs[${index}].chainId`),
			token: toHexString(o.token, `outputs[${index}].token`),
			amount: toBigIntValue(o.amount, `outputs[${index}].amount`),
			recipient: toHexString(o.recipient, `outputs[${index}].recipient`),
			callbackData: toHexString(o.callbackData ?? "0x", `outputs[${index}].callbackData`),
			context: toHexString(o.context ?? "0x", `outputs[${index}].context`)
		};
	});
}

function normalizeStandardOrder(order: Record<string, unknown>): StandardOrder {
	if (!Array.isArray(order.inputs)) throw new Error("Order payload invalid: inputs");
	return {
		user: toHexString(order.user, "order.user"),
		nonce: toBigIntValue(order.nonce, "order.nonce"),
		originChainId: toBigIntValue(order.originChainId, "order.originChainId"),
		expires: toNumberValue(order.expires, "order.expires"),
		fillDeadline: toNumberValue(order.fillDeadline, "order.fillDeadline"),
		inputOracle: toHexString(order.inputOracle, "order.inputOracle"),
		inputs: order.inputs.map((input, index) => {
			if (!Array.isArray(input) || input.length !== 2) {
				throw new Error(`Order payload invalid: inputs[${index}]`);
			}
			return [
				toBigIntValue(input[0], `inputs[${index}][0]`),
				toBigIntValue(input[1], `inputs[${index}][1]`)
			];
		}),
		outputs: normalizeOutputs(order.outputs)
	};
}

function normalizeMultichainOrder(order: Record<string, unknown>): MultichainOrder {
	if (!Array.isArray(order.inputs)) throw new Error("Order payload invalid: inputs");
	return {
		user: toHexString(order.user, "order.user"),
		nonce: toBigIntValue(order.nonce, "order.nonce"),
		expires: toNumberValue(order.expires, "order.expires"),
		fillDeadline: toNumberValue(order.fillDeadline, "order.fillDeadline"),
		inputOracle: toHexString(order.inputOracle, "order.inputOracle"),
		outputs: normalizeOutputs(order.outputs),
		inputs: order.inputs.map((input, index) => {
			if (!input || typeof input !== "object") {
				throw new Error(`Order payload invalid: inputs[${index}]`);
			}
			const i = input as Record<string, unknown>;
			if (!Array.isArray(i.inputs)) {
				throw new Error(`Order payload invalid: inputs[${index}].inputs`);
			}
			return {
				chainId: toBigIntValue(i.chainId, `inputs[${index}].chainId`),
				inputs: i.inputs.map((tuple, tupleIndex) => {
					if (!Array.isArray(tuple) || tuple.length !== 2) {
						throw new Error(`Order payload invalid: inputs[${index}].inputs[${tupleIndex}]`);
					}
					return [
						toBigIntValue(tuple[0], `inputs[${index}].inputs[${tupleIndex}][0]`),
						toBigIntValue(tuple[1], `inputs[${index}].inputs[${tupleIndex}][1]`)
					];
				})
			};
		})
	};
}

function extractOrderEnvelope(payload: unknown): OrderEnvelope {
	const root =
		payload && typeof payload === "object" && "data" in payload
			? (payload as Record<string, unknown>).data
			: payload;
	const candidateRaw = Array.isArray(root) ? root[0] : root;
	if (!candidateRaw || typeof candidateRaw !== "object") {
		throw new Error("Order payload invalid: data");
	}
	const candidate = candidateRaw as Record<string, unknown>;
	const c =
		candidate.intent && typeof candidate.intent === "object"
			? (candidate.intent as Record<string, unknown>)
			: candidate;
	if (!("order" in c) || !("inputSettler" in c)) {
		throw new Error("Order payload invalid: missing order fields");
	}
	return c as OrderEnvelope;
}

export function parseOrderStatusPayload(payload: unknown): OrderContainer {
	const envelope = extractOrderEnvelope(payload);
	const rawOrder = envelope.order as Record<string, unknown>;
	if (!rawOrder || typeof rawOrder !== "object") {
		throw new Error("Order payload invalid: order");
	}
	const order =
		"originChainId" in rawOrder
			? normalizeStandardOrder(rawOrder)
			: normalizeMultichainOrder(rawOrder);

	const container: OrderContainer = {
		inputSettler: toHexString(envelope.inputSettler, "inputSettler"),
		order,
		sponsorSignature: normalizeSignature(envelope.sponsorSignature),
		allocatorSignature: normalizeSignature(envelope.allocatorSignature)
	};

	// Capture the order-server submit time so the intent list can sort by it.
	// Normalize ms -> s defensively (the field is only typed as `number`).
	const meta = (envelope as Record<string, unknown>).meta as { submitTime?: unknown } | undefined;
	const rawSubmit = typeof meta?.submitTime === "number" ? meta.submitTime : undefined;
	if (rawSubmit !== undefined) {
		(container as { submitTime?: number }).submitTime =
			rawSubmit > 1e12 ? Math.floor(rawSubmit / 1000) : rawSubmit;
	}

	return container;
}

export class OrderServer {
	baseUrl: string;
	websocketUrl: string;

	api;

	constructor(mainnet: boolean) {
		this.baseUrl = OrderServer.getOrderServerUrl(mainnet);
		this.websocketUrl = OrderServer.getOrderServerWssUrl(mainnet);

		this.api = axios.create({
			baseURL: this.baseUrl,
			timeout: 15000
		});
	}

	private static sleep(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private static isNetworkError(error: unknown): boolean {
		if (!axios.isAxiosError(error)) return false;
		return error.code === "ERR_NETWORK" || error.code === "ECONNABORTED";
	}

	private async waitForOnline(maxWaitMs = 15000) {
		if (typeof window === "undefined" || typeof navigator === "undefined") return;
		if (navigator.onLine) return;
		await Promise.race([
			new Promise<void>((resolve) => {
				const onOnline = () => {
					window.removeEventListener("online", onOnline);
					resolve();
				};
				window.addEventListener("online", onOnline, { once: true });
			}),
			OrderServer.sleep(maxWaitMs)
		]);
	}

	private async postWithRetry<T>(
		path: string,
		body: unknown,
		opts: { retries?: number; baseDelayMs?: number } = {}
	): Promise<T> {
		const retries = opts.retries ?? 2;
		const baseDelayMs = opts.baseDelayMs ?? 500;
		let attempt = 0;
		while (true) {
			try {
				const response = await this.api.post(path, body);
				return response.data as T;
			} catch (error) {
				if (!OrderServer.isNetworkError(error) || attempt >= retries) throw error;
				await this.waitForOnline();
				await OrderServer.sleep(baseDelayMs * 2 ** attempt);
				attempt += 1;
			}
		}
	}

	static getOrderServerUrl(mainnet: boolean) {
		return mainnet ? "https://order.li.fi" : "https://order-dev.li.fi";
	}

	static getOrderServerWssUrl(mainnet: boolean) {
		return mainnet ? "wss://order.li.fi" : "wss://order-dev.li.fi";
	}

	/**
	 * @notice Submits an order to the order server
	 * @param request The order submission request
	 * @returns The response data from the order server
	 */
	async submitOrder(request: SubmitOrderDto) {
		try {
			return await this.postWithRetry("/orders/submit", request, { retries: 2, baseDelayMs: 600 });
		} catch (error) {
			console.error("Error submitting order:", error);
			throw error;
		}
	}

	/**
	 * @notice Gets latest orders from the order server
	 * @param options Optional parameters to filter orders
	 * @returns The response data containing the orders
	 */
	async getOrders(options?: { user?: `0x${string}`; status?: OrderStatus }) {
		try {
			const response = await this.api.get("/orders", {
				params: { limit: 50, offset: 0, ...options }
			});
			return response.data as GetOrderResponse;
		} catch (error) {
			console.error("Error getting orders:", error);
			throw error;
		}
	}

	/**
	 * @notice Gets an order by on-chain order id.
	 * @param orderId On-chain order id (0x-prefixed hash)
	 */
	async getOrderByOnChainOrderId(orderId: `0x${string}`): Promise<OrderContainer> {
		try {
			const response = await this.api.get("/orders/status/", {
				params: { onChainOrderId: orderId }
			});
			return parseOrderStatusPayload(response.data);
		} catch (error) {
			if (axios.isAxiosError(error) && error.response?.status === 404) {
				throw new Error("Order not found");
			}
			if (error instanceof Error && error.message.startsWith("Order payload invalid")) {
				throw error;
			}
			console.error("Error getting order by id:", error);
			throw new Error("Failed to fetch order");
		}
	}

	/**
	 * @notice Fetch an intent quote for a set of inputs and outputs.
	 * @param options The intent specifications
	 * @returns The response data containing the quotes
	 */
	async getQuotes(options: GetQuoteOptions): Promise<GetQuoteResponse> {
		const { user, userChain, inputs, outputs, minValidUntil, exclusiveFor } = options;

		const lockType: undefined | { kind: "the-compact" } = undefined;

		const rq: {
			user: string;
			intent: {
				intentType: "oif-swap";
				inputs: {
					user: string;
					asset: string;
					amount: string;
					lock: { kind: "the-compact" } | undefined;
				}[];
				outputs: {
					receiver: string;
					asset: string;
					amount: string;
				}[];
				swapType: "exact-input";
				minValidUntil: number | undefined;
				metadata?: {
					exclusiveFor: `0x${string}`[];
				};
			};
			supportedTypes: ["oif-escrow-v0"];
		} = {
			user: getInteropableAddress(user, chainMap[userChain].id),
			intent: {
				intentType: "oif-swap",
				inputs: inputs.map((input) => {
					return {
						user: getInteropableAddress(input.sender, chainMap[userChain].id),
						asset: getInteropableAddress(input.asset, chainMap[userChain].id),
						amount: input.amount.toString(),
						lock: lockType
					};
				}),
				outputs: outputs.map((output) => {
					return {
						receiver: getInteropableAddress(output.receiver, chainMap[output.chain].id),
						asset: getInteropableAddress(output.asset, chainMap[output.chain].id),
						amount: output.amount.toString()
					};
				}),
				swapType: "exact-input",
				minValidUntil
			},
			supportedTypes: ["oif-escrow-v0"]
		};
		if (exclusiveFor && exclusiveFor.length > 0) {
			rq.intent.metadata = { exclusiveFor: exclusiveFor.map(normalizeHexAddress) };
		}

		try {
			return await this.postWithRetry<GetQuoteResponse>("/quote/request", rq, {
				retries: 3,
				baseDelayMs: 700
			});
		} catch (error) {
			console.error("Error fetching quote:", error);
			throw error;
		}
	}

	connectOrderServerSocket(newOrderFunction: orderPush) {
		let shouldReconnect = true;
		let backoffMs = 1000;
		const MAX_BACKOFF = 30000;
		let socket: WebSocket;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

		const connect = () => {
			if (!shouldReconnect) return;
			socket = new WebSocket(this.websocketUrl);

			socket.onmessage = function (event) {
				const message = JSON.parse(event.data);

				switch (message.event) {
					case "user:vm-order-submit":
						const incomingOrder = message.data as SubmitOrderDto;
						newOrderFunction(incomingOrder);
						break;
					case "ping":
						socket.send(
							JSON.stringify({
								event: "pong"
							})
						);
						break;
					default:
						break;
				}
			};

			socket.addEventListener("open", () => {
				console.log("Connected to Catalyst order server");
				backoffMs = 1000; // Reset backoff on successful connection
			});

			socket.addEventListener("close", () => {
				console.log("Disconnected from Catalyst order server");
				if (shouldReconnect) {
					console.log(`Reconnecting in ${backoffMs}ms...`);
					if (reconnectTimer) clearTimeout(reconnectTimer);
					reconnectTimer = setTimeout(() => {
						reconnectTimer = undefined;
						connect();
					}, backoffMs);
					backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
				}
			});

			socket.addEventListener("error", (event) => {
				console.error("WebSocket error:", event);
			});
		};

		connect();

		return {
			get socket() {
				return socket;
			},
			disconnect: () => {
				shouldReconnect = false;
				if (reconnectTimer) {
					clearTimeout(reconnectTimer);
					reconnectTimer = undefined;
				}
				socket.close();
			}
		};
	}

	// -- Translations -- //

	/**
	 * @notice Fetches all intents from the LI.FI order server and then transmutes them into OrderContainers.
	 */
	async getAndParseOrders(): Promise<OrderContainer[] | undefined> {
		const response = await this.getOrders();
		const parsedOrders = response.data;
		if (parsedOrders) {
			if (Array.isArray(parsedOrders)) {
				// For each order, if a field is string ending in n, convert it to bigint.
				return parsedOrders.map((instance) => {
					instance.order.nonce = BigInt(instance.order.nonce);
					instance.order.originChainId = BigInt(instance.order.originChainId);
					if (instance.order.inputs) {
						instance.order.inputs = instance.order.inputs.map((input) => {
							return [BigInt(input[0]), BigInt(input[1])];
						});
					}
					if (instance.order.outputs) {
						instance.order.outputs = instance.order.outputs.map((output) => {
							return {
								...output,
								chainId: BigInt(output.chainId),
								amount: BigInt(output.amount)
							};
						});
					}
					const allocatorSignature = instance.allocatorSignature
						? ({
								type: "ECDSA",
								payload: instance.allocatorSignature
							} as Signature)
						: ({
								type: "None",
								payload: "0x"
							} as NoSignature);
					const sponsorSignature = instance.sponsorSignature
						? ({
								type: "ECDSA",
								payload: instance.sponsorSignature
							} as Signature)
						: ({
								type: "None",
								payload: "0x"
							} as NoSignature);
					return { ...instance, allocatorSignature, sponsorSignature };
				});
			}
		}
	}
}
