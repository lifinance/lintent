import { parseEventLogs, type Log } from "viem";
import { addressToBytes32 } from "@lifi/intent";

/**
 * Persisted evidence that a Hyperlane `submit` actually happened for one
 * (order, input chain, output) triple.
 *
 * Hyperlane is push based: the solver pays interchain gas on the OUTPUT chain and an
 * independent relayer later delivers `handle` on the INPUT chain. Two things follow:
 *
 *  1. "the fill landed" is NOT the same as "a message is in flight", so the UI must not
 *     claim the order is relaying until a submit is on record;
 *  2. a second `submit` dispatches a second message and pays again, so the record has
 *     to survive a page reload — reloading is the natural reaction to a stuck step.
 *
 * Hence this is persisted next to the other cross-order state (see
 * `store.hyperlaneSubmissions`), not held in a process-local map.
 */
export type HyperlaneSubmission = {
  /** `hyperlaneSubmissionKey(orderId, inputChainId, outputHash)`. */
  key: string;
  orderId: `0x${string}`;
  /** Chain the attestation must land on (where `handle` is delivered). */
  inputChainId: number;
  /** Chain `submit` was called on (where the interchain gas was paid). */
  outputChainId: number;
  /** `MandateOutput` struct hash — the same key `store.fillTransactions` uses. */
  outputHash: string;
  /**
   * keccak of the magic-tagged FillDescription payload, i.e. what `isProven` is keyed
   * by. Stored so a record left over from a different fill (different solver or
   * timestamp) is recognised as stale instead of suppressing a needed submit.
   */
  payloadHash: `0x${string}`;
  submitTxHash: `0x${string}`;
  /**
   * Hyperlane message id, parsed from the Mailbox `DispatchId` event. The oracle
   * discards the id `dispatch` returns, so the event is the only source. Undefined only
   * when the event could not be matched unambiguously.
   */
  messageId?: `0x${string}`;
  /** Unix seconds, for "how long has the relayer had this?". */
  submittedAt: number;
};

export function hyperlaneSubmissionKey(
  orderId: `0x${string}`,
  inputChainId: number | bigint,
  outputHash: string
) {
  return `${orderId.toLowerCase()}:${Number(inputChainId)}:${outputHash.toLowerCase()}`;
}

export function hyperlaneExplorerUrl(messageId: string) {
  return `https://explorer.hyperlane.xyz/message/${messageId}`;
}

/**
 * The two Mailbox events `dispatch` emits. Only used to read a message id back out of a
 * submit receipt — the app never calls the Mailbox.
 */
export const HYPERLANE_MAILBOX_ABI = [
  {
    type: "event",
    name: "Dispatch",
    inputs: [
      { name: "sender", type: "address", indexed: true, internalType: "address" },
      { name: "destination", type: "uint32", indexed: true, internalType: "uint32" },
      { name: "recipient", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "message", type: "bytes", indexed: false, internalType: "bytes" }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "DispatchId",
    inputs: [{ name: "messageId", type: "bytes32", indexed: true, internalType: "bytes32" }],
    anonymous: false
  }
] as const;

/**
 * Extracts the Hyperlane message id from a `submit` receipt.
 *
 * `HyperlaneOracle.submit` throws away the id `Mailbox.dispatch` returns, so the
 * `DispatchId` event is the only way to learn it — and without it "is the relayer slow
 * or did delivery revert?" cannot be answered from the app or the explorer.
 *
 * Matching is deliberate rather than "take the first bytes32": the sender, destination
 * domain and recipient of the paired `Dispatch` event are checked, so a receipt that
 * also contains unrelated dispatches cannot yield the wrong id. Returns undefined when
 * no unambiguous match exists — a missing id must never block the flow.
 */
export function findHyperlaneMessageId(
  logs: Log[],
  opts: {
    /** The oracle that called `dispatch`, i.e. the Mailbox's `sender`. */
    sender: `0x${string}`;
    destinationDomain: number;
    /** The input chain's oracle, i.e. the message recipient. */
    recipient: `0x${string}`;
  }
): `0x${string}` | undefined {
  const dispatchIds = parseEventLogs({
    abi: HYPERLANE_MAILBOX_ABI,
    eventName: "DispatchId",
    logs
  });
  if (dispatchIds.length === 0) return undefined;

  const expectedRecipient = addressToBytes32(opts.recipient).toLowerCase();
  const allDispatches = parseEventLogs({
    abi: HYPERLANE_MAILBOX_ABI,
    eventName: "Dispatch",
    logs
  });
  // Sender and recipient identify OUR message. The destination domain is checked too,
  // but only as a narrowing pass: Hyperlane domains equal the chain id on the chains
  // configured here, and if that ever stops holding, sender+recipient is still a sound
  // identification — whereas "just take the only bytes32 in the receipt" is not.
  const senderRecipientMatches = allDispatches.filter(
    (log) =>
      log.args.sender.toLowerCase() === opts.sender.toLowerCase() &&
      log.args.recipient.toLowerCase() === expectedRecipient
  );
  const domainMatches = senderRecipientMatches.filter(
    (log) => Number(log.args.destination) === opts.destinationDomain
  );
  const dispatches = domainMatches.length > 0 ? domainMatches : senderRecipientMatches;

  // Never guess: without a `Dispatch` that is provably ours, a returned id would be a
  // confidently wrong explorer link, which is worse than no link at all.
  if (dispatches.length !== 1) return undefined;

  // `Mailbox.dispatch` emits `Dispatch` immediately followed by `DispatchId`, both
  // from the Mailbox itself: pair them by emitter and log order.
  const dispatch = dispatches[0];
  const paired = dispatchIds
    .filter(
      (log) =>
        log.address.toLowerCase() === dispatch.address.toLowerCase() &&
        log.logIndex > dispatch.logIndex
    )
    .sort((a, b) => a.logIndex - b.logIndex)[0];
  return paired?.args.messageId;
}
