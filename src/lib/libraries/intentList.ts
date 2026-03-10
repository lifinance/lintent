import {
  formatTokenAmount,
  getChainName,
  getCoin,
  INPUT_SETTLER_ESCROW_LIFI,
  INPUT_SETTLER_COMPACT_LIFI,
  MULTICHAIN_INPUT_SETTLER_ESCROW,
  MULTICHAIN_INPUT_SETTLER_COMPACT
} from "../config";
import { orderToIntent } from "@lifi/intent";
import { bytes32ToAddress, idToToken } from "@lifi/intent";
import type { OrderContainer, StandardOrder, MultichainOrder } from "@lifi/intent";
import { validateOrderContainerWithReason } from "@lifi/intent";
import { orderValidationDeps } from "./coreDeps";

export type Chip = {
  key: string;
  text: string;
};

export type Status = "active" | "expiring" | "expired";
export type ChainScope = "singlechain" | "multichain" | "samechain";

export type BaseIntentRow = {
  orderContainer: OrderContainer;
  orderId: string;
  orderIdShort: string;
  userShort: string;
  fillDeadline: number;
  inputCount: number;
  outputCount: number;
  chainScope: ChainScope;
  chainScopeBadge: string;
  inputSchemeBadge?: string;
  orderTypeBadge?: string;
  exclusiveForAddress?: string;
  exclusiveUntil?: number;
  inputChips: Chip[];
  inputOverflow: number;
  outputChips: Chip[];
  outputOverflow: number;
  validationPassed: boolean;
  validationReason: string;
};

export type TimedIntentRow = BaseIntentRow & {
  status: Status;
  secondsToDeadline: number;
  protocolBadges: string[];
};

export const EXPIRING_THRESHOLD_SECONDS = 5 * 60;
export const MAX_CHIPS_PER_SIDE = 2;

function flattenInputs(inputs: { chainId: bigint; inputs: [bigint, bigint][] }[]) {
  return inputs.flatMap((chainInput) => {
    return chainInput.inputs.map((input) => ({
      chainId: chainInput.chainId,
      input
    }));
  });
}

function safeChainName(chainId: bigint): string | undefined {
  try {
    return getChainName(chainId);
  } catch {
    return undefined;
  }
}

function shortAddress(value: string, start = 6, end = 4) {
  if (value.length <= start + end) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function summarizeInput(chainId: bigint, tokenId: bigint, amount: bigint): string {
  const tokenAddress = idToToken(tokenId);
  const chainName = safeChainName(chainId);
  if (!chainName) {
    return `${amount.toString()} ${shortAddress(tokenAddress)} on chain-${chainId.toString()}`;
  }
  const coin = getCoin({ address: tokenAddress, chainId });
  const amountText = formatTokenAmount(amount, coin.decimals);
  return `${amountText} ${coin.name.toUpperCase()} on ${chainName}`;
}

function summarizeOutput(chainId: bigint, token: `0x${string}`, amount: bigint): string {
  const chainName = safeChainName(chainId);
  if (!chainName) {
    return `${amount.toString()} ${shortAddress(token)} on chain-${chainId.toString()}`;
  }
  const coin = getCoin({ address: token, chainId });
  const amountText = formatTokenAmount(amount, coin.decimals);
  return `${amountText} ${coin.name.toUpperCase()} on ${chainName}`;
}

function getInputs(order: StandardOrder | MultichainOrder) {
  if ("originChainId" in order) {
    return order.inputs.map((input, index) => ({
      key: `s-${index}-${input[0].toString()}`,
      text: summarizeInput(order.originChainId, input[0], input[1])
    }));
  }

  return flattenInputs(order.inputs).map((input, index) => ({
    key: `m-${index}-${input.input[0].toString()}`,
    text: summarizeInput(input.chainId, input.input[0], input.input[1])
  }));
}

function getOutputs(order: StandardOrder | MultichainOrder) {
  return order.outputs.map((output, index) => ({
    key: `o-${index}-${output.token}`,
    text: summarizeOutput(output.chainId, output.token, output.amount)
  }));
}

function getChainScope(order: StandardOrder | MultichainOrder): ChainScope {
  if (!("originChainId" in order)) return "multichain";
  const isSameChain = order.outputs.every((output) => output.chainId === order.originChainId);
  return isSameChain ? "samechain" : "singlechain";
}

function toChainScopeBadge(scope: ChainScope) {
  if (scope === "samechain") return "SameChain";
  if (scope === "singlechain") return "SingleChain";
  return "MultiChain";
}

function shortHexAddress(value: `0x${string}`) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function normalizeAddress(value: string) {
  return value.toLowerCase();
}

function mapInputScheme(inputSettler: `0x${string}`): string | undefined {
  const settler = normalizeAddress(inputSettler);
  if (settler === normalizeAddress(INPUT_SETTLER_ESCROW_LIFI)) return "Escrow";
  if (settler === normalizeAddress(INPUT_SETTLER_COMPACT_LIFI)) return "Compact";
  if (settler === normalizeAddress(MULTICHAIN_INPUT_SETTLER_ESCROW)) return "MultichainEscrow";
  if (settler === normalizeAddress(MULTICHAIN_INPUT_SETTLER_COMPACT)) return "MultichainCompact";
  return undefined;
}

function parseContextType(context: `0x${string}`) {
  if (context === "0x" || context === "0x00") return "Limit";
  const typeByte = context.slice(2, 4).toLowerCase();
  if (typeByte === "00") return "Limit";
  if (typeByte === "01") return "Dutch";
  if (typeByte === "e0") return "Limit";
  if (typeByte === "e1") return "Dutch";
  return undefined;
}

function decodeExclusiveFor(context: `0x${string}`): `0x${string}` | undefined {
  if (context.length < 2 + 2 + 64) return undefined;
  const exclusiveHex = context.slice(4, 68);
  try {
    return bytes32ToAddress(`0x${exclusiveHex}`);
  } catch {
    return undefined;
  }
}

type ContextDetails = {
  orderTypeBadge?: string;
  exclusiveForAddress?: string;
  exclusiveUntil?: number;
};

function getContextDetails(orderContainer: OrderContainer): ContextDetails {
  const order = orderContainer.order;
  const details: ContextDetails = {};

  const contexts = order.outputs.map((o) => o.context);
  const firstContext = contexts[0];
  const allContextsMatch = contexts.every((c) => c === firstContext);
  if (!firstContext || !allContextsMatch) return details;

  details.orderTypeBadge = parseContextType(firstContext);

  const typeByte = firstContext.slice(2, 4).toLowerCase();
  const isExclusive = typeByte === "e0" || typeByte === "e1";
  if (!isExclusive) return details;

  const exclusiveFor = decodeExclusiveFor(firstContext);
  if (exclusiveFor) details.exclusiveForAddress = shortHexAddress(exclusiveFor);

  // bytes1 + bytes32 + uint32 (big-endian)
  if (firstContext.length >= 76) {
    const untilHex = firstContext.slice(68, 76);
    const until = Number.parseInt(untilHex, 16);
    if (!Number.isNaN(until)) details.exclusiveUntil = until;
  }

  return details;
}

export function buildBaseIntentRow(orderContainer: OrderContainer): BaseIntentRow {
  const order = orderContainer.order;
  const orderId = orderToIntent(orderContainer).orderId();
  const inputChipsRaw = getInputs(order);
  const outputChipsRaw = getOutputs(order);
  const chainScope = getChainScope(order);
  const contextDetails = getContextDetails(orderContainer);

  const validation = validateOrderContainerWithReason({
    orderContainer,
    deps: orderValidationDeps
  });

  return {
    orderContainer,
    orderId,
    orderIdShort: shortAddress(orderId, 10, 4),
    userShort: shortAddress(order.user, 8, 4),
    fillDeadline: order.fillDeadline,
    inputCount: inputChipsRaw.length,
    outputCount: outputChipsRaw.length,
    chainScope,
    chainScopeBadge: toChainScopeBadge(chainScope),
    inputSchemeBadge: mapInputScheme(orderContainer.inputSettler),
    orderTypeBadge: contextDetails.orderTypeBadge,
    exclusiveForAddress: contextDetails.exclusiveForAddress,
    exclusiveUntil: contextDetails.exclusiveUntil,
    inputChips: inputChipsRaw.slice(0, MAX_CHIPS_PER_SIDE),
    inputOverflow: Math.max(0, inputChipsRaw.length - MAX_CHIPS_PER_SIDE),
    outputChips: outputChipsRaw.slice(0, MAX_CHIPS_PER_SIDE),
    outputOverflow: Math.max(0, outputChipsRaw.length - MAX_CHIPS_PER_SIDE),
    validationPassed: validation.passed,
    validationReason: validation.reason
  };
}

export function withTiming(baseRow: BaseIntentRow, nowSeconds: number): TimedIntentRow {
  const secondsToDeadline = baseRow.fillDeadline - nowSeconds;
  const status: Status =
    secondsToDeadline <= 0
      ? "expired"
      : secondsToDeadline <= EXPIRING_THRESHOLD_SECONDS
        ? "expiring"
        : "active";

  const protocolBadges: string[] = [];
  if (baseRow.orderTypeBadge) protocolBadges.push(baseRow.orderTypeBadge);
  if (baseRow.exclusiveForAddress)
    protocolBadges.push(`Exclusive for ${baseRow.exclusiveForAddress}`);
  if (baseRow.exclusiveUntil !== undefined) {
    const secondsRemaining = baseRow.exclusiveUntil - nowSeconds;
    if (secondsRemaining > 0) {
      protocolBadges.push(`Exclusive until ${formatRemaining(secondsRemaining)}`);
    }
  }

  return { ...baseRow, status, secondsToDeadline, protocolBadges };
}

export function formatRelativeDeadline(secondsToDeadline: number) {
  const abs = Math.abs(secondsToDeadline);
  if (abs < 60) return secondsToDeadline >= 0 ? `in ${abs}s` : `${abs}s ago`;
  const minutes = Math.floor(abs / 60);
  if (minutes < 60) return secondsToDeadline >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return secondsToDeadline >= 0 ? `in ${hours}h` : `${hours}h ago`;
}

export function formatRemaining(secondsToDeadline: number) {
  const clamped = Math.max(0, secondsToDeadline);
  if (clamped < 60) return `${clamped}s`;
  const minutes = Math.floor(clamped / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}
