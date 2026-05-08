import { getTronWeb } from "$lib/utils/tronlink";
import { COIN_FILLER, TRON_MAINNET_INPUT_SETTLER } from "$lib/config";
import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";
import { ERC20_ABI } from "$lib/abi/erc20";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import { addressToBytes32, bytes32ToAddress } from "@lifi/intent";
import { containerToIntent } from "$lib/utils/intent";
import axios from "axios";

function requireTronWeb(): TronWeb {
  const tw = getTronWeb();
  if (!tw) throw new Error("TronLink is not connected");
  return tw;
}

function toTronAddress(tw: TronWeb, hex: string): string {
  return tw.address.fromHex("41" + hex.replace("0x", ""));
}

export async function fillTronOutputs(
  orderContainer: OrderContainer,
  outputs: MandateOutput[],
  accountHex: `0x${string}`
): Promise<string> {
  const tw = requireTronWeb();
  const { order } = orderContainer;
  const orderId = containerToIntent(orderContainer).orderId();

  const settlerBase58 = toTronAddress(tw, bytes32ToAddress(outputs[0].settler));

  for (const output of outputs) {
    if (output.token === "0x0000000000000000000000000000000000000000000000000000000000000000")
      continue;

    const assetAddress = bytes32ToAddress(output.token);
    const assetBase58 = toTronAddress(tw, assetAddress);
    const tokenContract = await tw.contract(
      [...ERC20_ABI] as Record<string, unknown>[],
      assetBase58
    );

    const allowance = (await tokenContract
      .allowance(tw.defaultAddress.base58, settlerBase58)
      .call()) as bigint | string | number;

    if (BigInt(allowance.toString()) < output.amount) {
      const maxUint256 = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      await tokenContract.approve(settlerBase58, maxUint256).send({ feeLimit: 50_000_000 });
    }
  }

  const coinFillerBase58 = toTronAddress(tw, COIN_FILLER);
  const fillerContract = await tw.contract(
    [...COIN_FILLER_ABI] as Record<string, unknown>[],
    coinFillerBase58
  );

  const txId = await fillerContract
    .fillOrderOutputs(orderId, outputs, order.fillDeadline, addressToBytes32(accountHex))
    .send({ feeLimit: 150_000_000 });

  return txId;
}

export async function getTronTransactionInfo(txId: string): Promise<Record<string, unknown>> {
  const tw = requireTronWeb();
  return await tw.trx.getTransactionInfo(txId);
}

export async function validateTronFill(args: {
  output: MandateOutput;
  fillTxId: string;
  sourceChainId: number | bigint;
  mainnet: boolean;
  account: `0x${string}`;
}): Promise<string> {
  const tw = requireTronWeb();
  const { output, fillTxId, sourceChainId, mainnet, account } = args;

  const txInfo = await getTronTransactionInfo(fillTxId);
  const logs = (txInfo.log as Array<{ topics: string[]; data: string; address: string }>) ?? [];

  if (!logs.length) {
    throw new Error(`No logs found in Tron transaction ${fillTxId}`);
  }

  const response = await axios.post(
    `/polymer`,
    {
      srcChainId: Number(output.chainId),
      srcBlockNumber: Number(txInfo.blockNumber),
      globalLogIndex: 0,
      mainnet
    },
    { timeout: 15_000 }
  );
  const dat = response.data as { proof: undefined | string; polymerIndex: number };
  if (!dat.proof) {
    throw new Error(
      "Polymer proof unavailable for Tron fill. Try again after attestation is indexed."
    );
  }

  // TODO: This function needs rework — receiveMessage must be called on the
  // SOURCE chain's oracle, not on Tron. When source is EVM, use walletClient.
  const oracleBase58 = toTronAddress(tw, TRON_MAINNET_INPUT_SETTLER);
  const oracleContract = await tw.contract(
    [...SETTLER_ESCROW_ABI] as Record<string, unknown>[],
    oracleBase58
  );
  const resultTxId = await oracleContract.receiveMessage(`0x${dat.proof.replace("0x", "")}`).send({
    feeLimit: 150_000_000
  });
  return resultTxId;
}

export async function readTronOrderStatus(orderId: `0x${string}`): Promise<number> {
  const tw = requireTronWeb();
  const settlerBase58 = toTronAddress(tw, TRON_MAINNET_INPUT_SETTLER);
  const contract = await tw.contract(
    [...SETTLER_ESCROW_ABI] as Record<string, unknown>[],
    settlerBase58
  );
  const status = await contract.orderStatus(orderId).call();
  return Number(status);
}

export async function readTronIsProven(
  oracleHex: `0x${string}`,
  remoteChainId: bigint,
  remoteOracle: `0x${string}`,
  application: `0x${string}`,
  dataHash: `0x${string}`
): Promise<boolean> {
  const tw = requireTronWeb();
  const oracleBase58 = toTronAddress(tw, oracleHex);
  const contract = await tw.contract(
    [...POLYMER_ORACLE_ABI] as Record<string, unknown>[],
    oracleBase58
  );
  const result = await contract
    .isProven(remoteChainId.toString(), remoteOracle, application, dataHash)
    .call();
  return Boolean(result);
}

// Use only the single-bytes overload to avoid TronLink's ethers.js picking bytes[]
const RECEIVE_MESSAGE_SINGLE_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    inputs: [{ name: "proof", type: "bytes", internalType: "bytes" }],
    outputs: [],
    stateMutability: "nonpayable"
  }
] as const;

export async function submitTronReceiveMessage(
  oracleHex: `0x${string}`,
  proof: string
): Promise<string> {
  const tw = requireTronWeb();
  const oracleBase58 = toTronAddress(tw, oracleHex);
  const contract = await tw.contract(
    [...RECEIVE_MESSAGE_SINGLE_ABI] as Record<string, unknown>[],
    oracleBase58
  );

  const proofBytes = `0x${proof.replace("0x", "")}`;

  const txId = await contract.receiveMessage(proofBytes).send({ feeLimit: 150_000_000 });
  return txId;
}

export async function claimTronIntent(args: {
  orderContainer: OrderContainer;
  fillTimestamps: number[];
  account: `0x${string}`;
}): Promise<string> {
  const tw = requireTronWeb();
  const { orderContainer, fillTimestamps, account } = args;
  const { order } = orderContainer;
  const intent = containerToIntent(orderContainer);

  // TronLink's ethers.js v6 mangles localName for all coders in nested tuples,
  // so named objects fail. Pass solveParams as positional arrays [timestamp, solver].
  const solveParams = fillTimestamps.map((timestamp) => [
    Math.floor(timestamp),
    addressToBytes32(account)
  ]);

  if (!("originChainId" in order)) {
    throw new Error("Tron claim only supports single-chain (StandardOrder) intents");
  }

  const settlerBase58 = toTronAddress(tw, TRON_MAINNET_INPUT_SETTLER);
  const settlerContract = await tw.contract(
    [...SETTLER_ESCROW_ABI] as Record<string, unknown>[],
    settlerBase58
  );

  // TronLink's ethers.js v6 replaces `address` type coders with Tron-specific
  // ones that lose their localName, so encoding a named object fails with
  // "cannot encode object for signature with missing names". Pass as a
  // positional array (index-based encoding) and convert address fields to
  // Tron base58 format.
  const orderTuple = [
    toTronAddress(tw, order.user), // user (address)
    order.nonce, // nonce (uint256)
    order.originChainId, // originChainId (uint256)
    order.expires, // expires (uint32)
    order.fillDeadline, // fillDeadline (uint32)
    toTronAddress(tw, order.inputOracle), // inputOracle (address)
    order.inputs, // inputs (uint256[2][])
    order.outputs.map((o: MandateOutput) => [
      o.oracle,
      o.settler,
      o.chainId,
      o.token,
      o.amount,
      o.recipient,
      o.callbackData,
      o.context
    ])
  ];

  const txId = await settlerContract
    .finalise(orderTuple, solveParams, addressToBytes32(account), "0x")
    .send({ feeLimit: 150_000_000 });

  return txId;
}
