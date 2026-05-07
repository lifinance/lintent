// Cross-VM types

import type {
  EVMOrder,
  MultichainOrder,
  MandateOutput,
  Signature,
  NoSignature,
} from "@lifi/intent";

export type { MandateOutput } from "@lifi/intent";

export type Vm = "evm" | "svm";
export type SettlerType = "escrow" | "compact";
export type Verifier = "polymer" | "wormhole";
export type OrderStatus = "active" | "expiring" | "expired" | "filled" | "settled";

export type StandardOrderData = EVMOrder & { kind: "standard" };

export type MultichainOrderData = MultichainOrder & { kind: "multichain" };

export type OrderContainer = {
  orderId: string;
  inputSettler: string;
  vm: Vm;
  settler: SettlerType;
  sponsorSignature: Signature | NoSignature;
  allocatorSignature: Signature | NoSignature;
  order: StandardOrderData | MultichainOrderData | SvmOrderData;
  createdAt: number;
};

/** Serialisable form of a Solana-originated standard order. */
export type SvmOrderData = {
  kind: "svm_standard";
  user: string;              // base58 public key (for Anchor/web3.js PublicKey construction)
  userBytes32: `0x${string}`;
  nonce: bigint;
  originChainId: bigint;
  expires: number;
  fillDeadline: number;
  inputOracle: string;       // base58 PDA public key
  inputOracleBytes32: `0x${string}`;
  input: {
    token: string;           // base58 SPL mint (for Anchor/web3.js PublicKey construction)
    tokenBytes32: `0x${string}`;
    amount: bigint;
  };
  outputs: MandateOutput[];
};

/** Record stored after filling a Solana output (EVM→Solana intents). */
export type SolanaFilledRecord = {
  kind: "solanaOutputFilled";
  fillSignature: string;
  fillTimestamp: number;
  solverBytes32: `0x${string}`;
  localAttestation: string;
  orderId: `0x${string}`;
};

export type SolanaSubmittedFillRecord = {
  kind: "solanaOutputSubmittedFill";
  fillSignature: string;
  fillTimestamp: number;
  solverBytes32: `0x${string}`;
  localAttestation: string;
  orderId: `0x${string}`;
  submitSignature: string;
  submitSlot: number;
  submitLogIndex: number;
};

export type SolanaFillRecord =
  | SolanaFilledRecord
  | SolanaSubmittedFillRecord;

export function isSolanaFillRecord(value: unknown): value is SolanaFillRecord {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: string }).kind;
  return kind === "solanaOutputFilled" || kind === "solanaOutputSubmittedFill";
}

export function isSolanaSubmittedFillRecord(value: unknown): value is SolanaSubmittedFillRecord {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: string }).kind === "solanaOutputSubmittedFill";
}

export function getOrderStatus(order: OrderContainer, isClaimed = false): OrderStatus {
  if (isClaimed) return "filled";
  const now = Math.floor(Date.now() / 1000);
  const deadline = order.order.fillDeadline;
  const expires = order.order.expires;
  if (now > expires) return "expired";
  if (deadline - now < 300) return "expiring";
  return "active";
}
