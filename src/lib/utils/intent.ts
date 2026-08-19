import {
  orderToIntent,
  StandardEVMIntent,
  StandardSolanaIntent,
  MultichainOrderIntent
} from "@lifi/intent";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import { isSolanaChain, isTronChain } from "./chainType";

/**
 * Re-establish the `bigint` fields of an order that has been through JSON.
 *
 * Two ingestion paths deliver orders as parsed JSON with decimal strings in
 * every `bigint`-typed field: the local DB (persisted under the
 * `BigInt.prototype.toJSON` polyfill, read back with a plain `JSON.parse`) and
 * the order-server websocket (`user:vm-order-submit` hands over `message.data`
 * raw — unlike `getAndParseOrders`, which converts). Downstream code trusts
 * the types: `"…" & 0xffn` in a Solana PDA derivation throws "Cannot mix
 * BigInt and other types", and a string/bigint pair is never `===`, so a
 * same-chain output was silently classified as remote.
 */
export function reviveOrderBigInts(order: OrderContainer["order"]): OrderContainer["order"] {
  const outputs = order.outputs.map(
    (output): MandateOutput => ({
      ...output,
      chainId: BigInt(output.chainId),
      amount: BigInt(output.amount)
    })
  );
  if ("originChainId" in order) {
    return {
      ...order,
      nonce: BigInt(order.nonce),
      originChainId: BigInt(order.originChainId),
      inputs: order.inputs.map(([token, amount]): [bigint, bigint] => [
        BigInt(token),
        BigInt(amount)
      ]),
      outputs
    };
  }
  return {
    ...order,
    nonce: BigInt(order.nonce),
    inputs: order.inputs.map((input) => ({
      chainId: BigInt(input.chainId),
      inputs: input.inputs.map(([token, amount]): [bigint, bigint] => [
        BigInt(token),
        BigInt(amount)
      ])
    })),
    outputs
  };
}

export function containerToIntent(
  container: OrderContainer
): StandardEVMIntent | StandardSolanaIntent | MultichainOrderIntent {
  const { inputSettler, order } = container;
  if (!("originChainId" in order)) {
    return orderToIntent({ namespace: "eip155", inputSettler, order });
  }
  if (isSolanaChain(order.originChainId)) {
    return orderToIntent({ namespace: "solana", inputSettler, order });
  }
  if (isTronChain(order.originChainId)) {
    return orderToIntent({ namespace: "tron", inputSettler, order });
  }
  return orderToIntent({ namespace: "eip155", inputSettler, order });
}
