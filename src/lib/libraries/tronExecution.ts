import { getTronWeb } from "$lib/utils/tronlink";
import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";
import { ERC20_ABI } from "$lib/abi/erc20";
import { TRON_MAINNET_INPUT_SETTLER } from "$lib/config";
import type { StandardEVMIntent } from "@lifi/intent";
import type { EVMOrder } from "@lifi/intent";

function requireTronWeb(): TronWeb {
  const tw = getTronWeb();
  if (!tw) throw new Error("TronLink is not connected");
  return tw;
}

function toTronAddress(tw: TronWeb, hex: `0x${string}`): string {
  return tw.address.fromHex("41" + hex.replace("0x", ""));
}

// TronLink's injected ethers.js v6 can't encode named-object structs because
// its ABI parser leaves localName empty. Convert to positional arrays so the
// encoder uses index-based matching instead. Address-typed fields must also be
// converted to Tron base58 format or TronLink encodes them incorrectly.
function orderToTronTuple(tw: TronWeb, order: EVMOrder): unknown[] {
  return [
    toTronAddress(tw, order.user),
    order.nonce.toString(),
    order.originChainId.toString(),
    order.expires,
    order.fillDeadline,
    toTronAddress(tw, order.inputOracle),
    order.inputs.map(([token, amount]) => [token.toString(), amount.toString()]),
    order.outputs.map((o) => [
      o.oracle,
      o.settler,
      o.chainId.toString(),
      o.token,
      o.amount.toString(),
      o.recipient,
      o.callbackData,
      o.context
    ])
  ];
}

export async function getTronBlockTimestamp(blockNumber: number): Promise<number> {
  const tw = requireTronWeb();
  const block = await tw.trx.getBlock(blockNumber);
  // Tron block timestamps are milliseconds; convert to seconds for consistency with EVM
  return Math.floor(Number(block.block_header.raw_data.timestamp) / 1000);
}

export async function openTronEscrowIntent(
  intent: StandardEVMIntent,
  _userHexAddress: `0x${string}`
): Promise<string> {
  const tw = requireTronWeb();
  const order = intent.asOrder();

  const settlerAddress = toTronAddress(tw, TRON_MAINNET_INPUT_SETTLER);
  const contract = await tw.contract(
    [...SETTLER_ESCROW_ABI] as Record<string, unknown>[],
    settlerAddress
  );

  const txId = await contract.open(orderToTronTuple(tw, order)).send({
    feeLimit: 150_000_000
  });
  return txId;
}

export async function approveTronToken(
  tokenHex: `0x${string}`,
  spenderHex: `0x${string}`,
  _amount: bigint
): Promise<string> {
  const tw = requireTronWeb();

  const tokenAddress = toTronAddress(tw, tokenHex);
  const spenderAddress = toTronAddress(tw, spenderHex);
  const contract = await tw.contract([...ERC20_ABI] as Record<string, unknown>[], tokenAddress);

  const maxUint256 = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const txId = await contract.approve(spenderAddress, maxUint256).send({
    feeLimit: 50_000_000
  });
  return txId;
}

export function signTronCompact(): never {
  throw new Error(
    "Tron compact signing not yet supported — pending protocol decision on EIP-712 alternative"
  );
}
