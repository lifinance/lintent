import {
  IntentApi,
  addressToBytes32,
  stellarStrkeyToBytes32,
  bytes32ToStellarContract,
  encodeStellarOrder,
  type StandardOrder,
  type MandateOutput,
  type GetQuoteOptions
} from "@lifi/intent";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { bytesToHex, decodeFunctionData } from "viem";
import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";
import {
  AXELAR_ORACLE,
  isStellarChain,
  stellarTestnetConfig,
  stellarDeployment,
  requireAlignedAxelar
} from "$lib/config";
import {
  BASE_TESTNET_USDC,
  STELLAR_TESTNET_ID,
  STELLAR_TESTNET_USDC,
  stellarContractHex
} from "$lib/stellarTestnet";
import type { AppTokenContext } from "$lib/appTypes";

export type SelectedApiQuote = Awaited<ReturnType<IntentApi["getQuotes"]>>["quotes"][number];
export type ApiQuoteContext = {
  inputs: AppTokenContext[];
  outputs: AppTokenContext[];
  user: string;
  recipient: string;
  exclusiveFor?: `0x${string}`[];
  mainnet?: boolean;
  verifier?: string;
  lockType?: "escrow" | "compact";
};
export const BASE_INPUT_ESCROW = "0x00fc00edbe7c003b006f870068c548940000223e" as const;
export const BASE_OUTPUT_SETTLER = "0x75220b7600c300005038432a0000f308e0000068" as const;
export function apiQuoteRequest(context: ApiQuoteContext): GetQuoteOptions {
  const { inputs, outputs, user, recipient, exclusiveFor } = context;
  if (!user || !recipient)
    throw new Error("Connect the origin wallet and choose a destination recipient");
  const stellar = [...inputs, ...outputs].some(({ token }) => isStellarChain(token.chainId));
  if (stellar) {
    if (context.mainnet)
      throw new Error("Switch to Testnet before requesting or executing this corridor");
    if (
      (context.verifier !== undefined && context.verifier !== "axelar") ||
      (context.lockType !== undefined && context.lockType !== "escrow")
    )
      throw new Error("Testnet API quotes require Axelar escrow");
    if (inputs.length !== 1 || outputs.length !== 1)
      throw new Error("Testnet corridor requires one USDC input and output");
    requireAlignedAxelar(inputs[0].token.chainId, outputs[0].token.chainId);
    for (const { token } of [...inputs, ...outputs]) {
      const expected = isStellarChain(token.chainId)
        ? stellarContractHex(STELLAR_TESTNET_USDC)
        : BASE_TESTNET_USDC;
      if (
        token.address.toLowerCase() !== expected.toLowerCase() ||
        token.decimals !== (isStellarChain(token.chainId) ? 7 : 6)
      )
        throw new Error("Only the configured testnet USDC assets are supported");
    }
  }
  const namespace = (id: number) =>
    isStellarChain(id) ? ("stellar" as const) : ("eip155" as const);
  const deployment = stellarTestnetConfig.deployment;
  return {
    user,
    userChainId: inputs[0].token.chainId,
    userNamespace: namespace(inputs[0].token.chainId),
    exclusiveFor,
    inputs: inputs.map(({ token, amount }) => ({
      sender: user,
      asset: token.address,
      chainId: token.chainId,
      namespace: namespace(token.chainId),
      amount
    })),
    outputs: outputs.map(({ token }) => ({
      receiver: recipient,
      asset: token.address,
      chainId: token.chainId,
      namespace: namespace(token.chainId),
      amount: 0n
    })),
    ...(stellar && deployment
      ? {
          oracle: [
            {
              chainId: STELLAR_TESTNET_ID,
              namespace: "stellar" as const,
              address: deployment.stellar.axelarOracle
            },
            {
              chainId: 84532,
              namespace: "eip155" as const,
              address: deployment.baseSepolia.axelarOracle
            }
          ]
        }
      : {})
  };
}
function wire(value: string): `0x${string}` {
  return value.startsWith("C") || value.startsWith("G")
    ? stellarStrkeyToBytes32(value)
    : addressToBytes32(value as `0x${string}`);
}
function same(a: string, b: string) {
  return wire(a).toLowerCase() === wire(b).toLowerCase();
}

function fields(value: xdr.ScVal, names: string[]) {
  if (value.type !== "scvMap") throw new Error("Invalid Stellar order struct");
  const entries = value.map;
  if (!entries || entries.length !== names.length) throw new Error("Invalid Stellar order fields");
  const result: Record<string, xdr.ScVal> = {};
  for (const entry of entries) {
    if (entry.key.type !== "scvSymbol") throw new Error("Invalid Stellar order field key");
    const name = entry.key.sym.toString();
    if (!names.includes(name) || result[name]) throw new Error("Invalid Stellar order field");
    result[name] = entry.val;
  }
  return result;
}
function uint(value: xdr.ScVal) {
  if (value.type !== "scvU256" && value.type !== "scvU32")
    throw new Error("Invalid Stellar integer");
  const native: unknown = scValToNative(value);
  if (typeof native !== "number" && typeof native !== "bigint")
    throw new Error("Invalid Stellar integer value");
  return BigInt(native);
}
function bytes(value: xdr.ScVal) {
  if (value.type !== "scvBytes") throw new Error("Invalid Stellar byte field");
  return bytesToHex(value.bytes.toBytes());
}
function contract(value: xdr.ScVal) {
  const native: unknown = scValToNative(value);
  if (value.type !== "scvAddress" || typeof native !== "string" || !native.startsWith("C"))
    throw new Error("Invalid Stellar contract field");
  return stellarStrkeyToBytes32(native);
}
function vector(value: xdr.ScVal) {
  if (value.type !== "scvVec" || !value.vec) throw new Error("Invalid Stellar vector");
  return value.vec;
}

/** Decode for validation/storage only. Execution always sends the untouched API payload. */
export function decodeApiQuoteOrder(quote: SelectedApiQuote): {
  order: StandardOrder;
  scval?: xdr.ScVal;
} {
  const tx = quote.order.openIntentTx;
  if (tx.chain.startsWith("eip155:")) {
    const decoded = decodeFunctionData({ abi: SETTLER_ESCROW_ABI, data: tx.data as `0x${string}` });
    if (decoded.functionName !== "open") throw new Error("Quote is not an escrow open call");
    return { order: decoded.args[0] as StandardOrder };
  }
  if (!tx.chain.startsWith("stellar:"))
    throw new Error("Unsupported API quote execution namespace");
  const scval = xdr.ScVal.fromXDR(tx.data, "base64");
  if (scval.type !== "scvMap")
    throw new Error("Quote data must be an order ScVal, not an envelope");
  const value = fields(scval, [
    "expires",
    "fill_deadline",
    "input_oracle",
    "inputs",
    "nonce",
    "origin_chain",
    "outputs",
    "user"
  ]);
  const outputs: MandateOutput[] = vector(value.outputs).map((item) => {
    const o = fields(item, [
      "amount",
      "callback_data",
      "chain_id",
      "context",
      "oracle",
      "recipient",
      "settler",
      "token"
    ]);
    return {
      oracle: bytes(o.oracle),
      settler: bytes(o.settler),
      chainId: uint(o.chain_id),
      token: bytes(o.token),
      amount: uint(o.amount),
      recipient: bytes(o.recipient),
      callbackData: bytes(o.callback_data),
      context: bytes(o.context)
    };
  });
  const user: unknown = scValToNative(value.user);
  if (value.user.type !== "scvAddress" || typeof user !== "string" || !user.startsWith("G"))
    throw new Error("Invalid Stellar user account");
  return {
    scval,
    order: {
      user: stellarStrkeyToBytes32(user),
      nonce: BigInt(bytes(value.nonce)),
      originChainId: uint(value.origin_chain),
      expires: Number(uint(value.expires)),
      fillDeadline: Number(uint(value.fill_deadline)),
      inputOracle: contract(value.input_oracle),
      inputs: vector(value.inputs).map((item) => {
        const i = fields(item, ["amount", "token"]);
        return [BigInt(contract(i.token)), uint(i.amount)];
      }),
      outputs
    }
  };
}
export function validateApiQuote(
  quote: SelectedApiQuote,
  context: ApiQuoteContext,
  now = Date.now()
) {
  apiQuoteRequest(context);
  const input = context.inputs[0];
  const output = context.outputs[0];
  requireAlignedAxelar(input.token.chainId, output.token.chainId);
  if (
    quote.order.type !== "oif-user-open-v0" ||
    !quote.quoteId ||
    !quote.metadata.quoteReference ||
    (quote.validUntil !== undefined &&
      (!Number.isSafeInteger(quote.validUntil) || quote.validUntil * 1000 <= now))
  )
    throw new Error("Quote expired or missing identity/validity");
  if (quote.partialFill) throw new Error("Partial quotes are not supported for this corridor");
  const tx = quote.order.openIntentTx;
  const expectedChain = `${isStellarChain(input.token.chainId) ? "stellar" : "eip155"}:${input.token.chainId}`;
  const inputSettler = isStellarChain(input.token.chainId)
    ? bytes32ToStellarContract(stellarDeployment(BigInt(input.token.chainId))!.inputEscrow)
    : BASE_INPUT_ESCROW;
  if (tx.chain !== expectedChain || !same(tx.to, inputSettler))
    throw new Error("Quote origin chain/escrow differs from request");
  if (
    !same(quote.metadata.oracle.input, AXELAR_ORACLE[input.token.chainId]!) ||
    !same(quote.metadata.oracle.output, AXELAR_ORACLE[output.token.chainId]!)
  )
    throw new Error("Quote oracle deployment differs from request");
  for (const [items, expected, actor] of [
    [quote.preview.inputs, input, context.user],
    [quote.preview.outputs, output, context.recipient]
  ] as const) {
    const p = items[0];
    if (
      items.length !== 1 ||
      p.chain !==
        `${isStellarChain(expected.token.chainId) ? "stellar" : "eip155"}:${expected.token.chainId}` ||
      !same(p.asset, expected.token.address) ||
      !same(p.user ?? p.receiver ?? "", actor) ||
      !/^\d+$/.test(p.amount) ||
      BigInt(p.amount) <= 0n
    )
      throw new Error("Quote preview differs from requested account/route/asset");
  }
  if (BigInt(quote.preview.inputs[0].amount) !== input.amount)
    throw new Error("Quote input amount changed");
  const decoded = decodeApiQuoteOrder(quote);
  const order = decoded.order;
  const out = order.outputs[0];
  const expectedOutputSettler = isStellarChain(output.token.chainId)
    ? stellarDeployment(BigInt(output.token.chainId))!.outputSettler
    : BASE_OUTPUT_SETTLER;
  if (
    !same(order.user, context.user) ||
    BigInt(order.originChainId) !== BigInt(input.token.chainId) ||
    order.expires * 1000 <= now ||
    order.fillDeadline * 1000 <= now ||
    !same(order.inputOracle, quote.metadata.oracle.input) ||
    order.inputs.length !== 1 ||
    BigInt(order.inputs[0][0]) !== BigInt(input.token.address) ||
    BigInt(order.inputs[0][1]) !== input.amount ||
    order.outputs.length !== 1 ||
    BigInt(out.chainId) !== BigInt(output.token.chainId) ||
    !same(out.settler, expectedOutputSettler) ||
    !same(out.oracle, quote.metadata.oracle.output) ||
    !same(out.token, output.token.address) ||
    !same(out.recipient, context.recipient) ||
    BigInt(out.amount) !== BigInt(quote.preview.outputs[0].amount) ||
    out.callbackData !== "0x"
  )
    throw new Error("Executable order differs from requested account/route/asset/settlers");
  if (
    !/^0x[0-9a-fA-F]{1,64}$/.test(quote.metadata.quoteReference) ||
    BigInt(order.nonce) !== BigInt(quote.metadata.quoteReference)
  )
    throw new Error("Quote reference does not match the executable nonce");
  if (decoded.scval && bytesToHex(encodeStellarOrder(order)) !== bytesToHex(decoded.scval.toXDR()))
    throw new Error("Stellar order ScVal is not canonical");
  const exclusive = quote.metadata.exclusiveFor;
  if (
    context.exclusiveFor?.length &&
    (!exclusive || !context.exclusiveFor.some((value) => same(value, exclusive)))
  )
    throw new Error("Quote exclusive claimant differs from request");
  if (
    exclusive &&
    (!["e0", "e1"].includes(out.context.slice(2, 4)) ||
      !same(`0x${out.context.slice(4, 68)}`, exclusive))
  )
    throw new Error("Executable exclusive claimant differs from quote metadata");
  if (isStellarChain(output.token.chainId)) {
    const expectedKind = context.recipient.startsWith("G")
      ? "00"
      : context.recipient.startsWith("C")
        ? "01"
        : undefined;
    if (!expectedKind || !out.context.endsWith(expectedKind))
      throw new Error("Stellar recipient kind differs from request");
  }
  if (quote.order.checks.allowances.length !== (isStellarChain(input.token.chainId) ? 0 : 1))
    throw new Error("Quote allowance set differs from the USDC escrow request");
  for (const allowance of quote.order.checks.allowances) {
    if (
      isStellarChain(input.token.chainId) ||
      allowance.chain !== expectedChain ||
      !same(allowance.token, input.token.address) ||
      !same(allowance.user, context.user) ||
      !same(allowance.spender, inputSettler) ||
      !/^\d+$/.test(allowance.required) ||
      BigInt(allowance.required) !== input.amount
    )
      throw new Error("Unexpected quote allowance");
  }
  if (tx.value !== undefined && BigInt(tx.value) !== 0n)
    throw new Error("USDC escrow quote must not spend native value");
  return { ...decoded, inputSettler: wire(inputSettler) };
}
