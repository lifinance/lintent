import { describe, expect, it } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Log } from "viem";
import {
  HYPERLANE_MAILBOX_ABI,
  findHyperlaneMessageId,
  hyperlaneExplorerUrl,
  hyperlaneSubmissionKey
} from "../../src/lib/libraries/hyperlaneSubmission";
import { getOrderExpiry } from "../../src/lib/libraries/orderExpiry";

const MAILBOX = "0x979Ca5202784112f4738403dBec5D0F3B9daabB9" as const;
const OTHER_MAILBOX = "0xeA87ae93Fa0019a82A727bfd3eBd1cFCa8f64f1D" as const;
const OUTPUT_ORACLE = "0x2A2A7570354787A6D5D797b43EE5f5c1f6a0f163" as const;
const INPUT_ORACLE = "0x24d39b2807c6B50882fB6B9a4B4Dc6D36bbb297d" as const;
const STRANGER = "0x1111111111111111111111111111111111111111" as const;
const DESTINATION_DOMAIN = 8453;

const MESSAGE_ID = `0x${"11".repeat(32)}` as const;
const OTHER_MESSAGE_ID = `0x${"22".repeat(32)}` as const;

function dispatchLog(opts: {
  address?: `0x${string}`;
  sender: `0x${string}`;
  destination: number;
  recipient: `0x${string}`;
  logIndex: number;
}): Log {
  const topics = encodeEventTopics({
    abi: HYPERLANE_MAILBOX_ABI,
    eventName: "Dispatch",
    args: {
      sender: opts.sender,
      destination: opts.destination,
      recipient: opts.recipient
    }
  });
  return {
    address: opts.address ?? MAILBOX,
    topics,
    data: encodeAbiParameters([{ type: "bytes" }], ["0xdeadbeef"]),
    blockHash: `0x${"00".repeat(32)}`,
    blockNumber: 1n,
    logIndex: opts.logIndex,
    transactionHash: `0x${"01".repeat(32)}`,
    transactionIndex: 0,
    removed: false
  } as unknown as Log;
}

function dispatchIdLog(opts: {
  address?: `0x${string}`;
  messageId: `0x${string}`;
  logIndex: number;
}): Log {
  const topics = encodeEventTopics({
    abi: HYPERLANE_MAILBOX_ABI,
    eventName: "DispatchId",
    args: { messageId: opts.messageId }
  });
  return {
    address: opts.address ?? MAILBOX,
    topics,
    data: "0x",
    blockHash: `0x${"00".repeat(32)}`,
    blockNumber: 1n,
    logIndex: opts.logIndex,
    transactionHash: `0x${"01".repeat(32)}`,
    transactionIndex: 0,
    removed: false
  } as unknown as Log;
}

const recipientBytes32 = `0x000000000000000000000000${INPUT_ORACLE.slice(2)}` as const;

describe("findHyperlaneMessageId", () => {
  const opts = {
    sender: OUTPUT_ORACLE,
    destinationDomain: DESTINATION_DOMAIN,
    recipient: INPUT_ORACLE
  };

  it("reads the message id from the DispatchId paired with the matching Dispatch", () => {
    const logs = [
      dispatchLog({
        sender: OUTPUT_ORACLE,
        destination: DESTINATION_DOMAIN,
        recipient: recipientBytes32,
        logIndex: 4
      }),
      dispatchIdLog({ messageId: MESSAGE_ID, logIndex: 5 })
    ];
    expect(findHyperlaneMessageId(logs, opts)).toBe(MESSAGE_ID);
  });

  it("ignores a DispatchId emitted by a different mailbox", () => {
    const logs = [
      dispatchLog({
        sender: OUTPUT_ORACLE,
        destination: DESTINATION_DOMAIN,
        recipient: recipientBytes32,
        logIndex: 4
      }),
      dispatchIdLog({ address: OTHER_MAILBOX, messageId: OTHER_MESSAGE_ID, logIndex: 5 }),
      dispatchIdLog({ messageId: MESSAGE_ID, logIndex: 6 })
    ];
    expect(findHyperlaneMessageId(logs, opts)).toBe(MESSAGE_ID);
  });

  it("picks the id of OUR dispatch when the receipt carries someone else's too", () => {
    const logs = [
      dispatchLog({
        sender: STRANGER,
        destination: DESTINATION_DOMAIN,
        recipient: recipientBytes32,
        logIndex: 1
      }),
      dispatchIdLog({ messageId: OTHER_MESSAGE_ID, logIndex: 2 }),
      dispatchLog({
        sender: OUTPUT_ORACLE,
        destination: DESTINATION_DOMAIN,
        recipient: recipientBytes32,
        logIndex: 3
      }),
      dispatchIdLog({ messageId: MESSAGE_ID, logIndex: 4 })
    ];
    expect(findHyperlaneMessageId(logs, opts)).toBe(MESSAGE_ID);
  });

  it("still pairs when only the destination domain differs from the chain id", () => {
    // Hyperlane domains equal the chain id on the configured chains, but sender plus
    // recipient already identify the message, so a domain mismatch must not lose the id.
    const logs = [
      dispatchLog({
        sender: OUTPUT_ORACLE,
        destination: 999,
        recipient: recipientBytes32,
        logIndex: 1
      }),
      dispatchIdLog({ messageId: MESSAGE_ID, logIndex: 2 })
    ];
    expect(findHyperlaneMessageId(logs, opts)).toBe(MESSAGE_ID);
  });

  it("never returns a lone DispatchId that belongs to someone else's dispatch", () => {
    // The dangerous case: exactly one DispatchId in the receipt, but the only Dispatch is
    // not ours. Returning it would render a confidently wrong explorer link.
    const logs = [
      dispatchLog({
        sender: STRANGER,
        destination: DESTINATION_DOMAIN,
        recipient: recipientBytes32,
        logIndex: 1
      }),
      dispatchIdLog({ messageId: OTHER_MESSAGE_ID, logIndex: 2 })
    ];
    expect(findHyperlaneMessageId(logs, opts)).toBeUndefined();
  });

  it("returns undefined rather than guessing when nothing is unambiguous", () => {
    expect(findHyperlaneMessageId([], opts)).toBeUndefined();
    const ambiguous = [
      dispatchLog({
        sender: STRANGER,
        destination: DESTINATION_DOMAIN,
        recipient: recipientBytes32,
        logIndex: 1
      }),
      dispatchIdLog({ messageId: OTHER_MESSAGE_ID, logIndex: 2 }),
      dispatchIdLog({ messageId: MESSAGE_ID, logIndex: 3 })
    ];
    expect(findHyperlaneMessageId(ambiguous, opts)).toBeUndefined();
  });
});

describe("hyperlaneSubmissionKey", () => {
  it("is case-insensitive and separates order, input chain and output", () => {
    const orderId = `0x${"AB".repeat(32)}` as const;
    const outputHash = `0x${"CD".repeat(32)}`;
    expect(hyperlaneSubmissionKey(orderId, 8453, outputHash)).toBe(
      hyperlaneSubmissionKey(
        orderId.toLowerCase() as `0x${string}`,
        8453n,
        outputHash.toLowerCase()
      )
    );
    expect(hyperlaneSubmissionKey(orderId, 8453, outputHash)).not.toBe(
      hyperlaneSubmissionKey(orderId, 42161, outputHash)
    );
  });
});

describe("hyperlaneExplorerUrl", () => {
  it("points at the Hyperlane message explorer", () => {
    expect(hyperlaneExplorerUrl(MESSAGE_ID)).toBe(
      `https://explorer.hyperlane.xyz/message/${MESSAGE_ID}`
    );
  });
});

describe("getOrderExpiry", () => {
  const nowMs = 1_700_000_000_000;
  const nowSec = nowMs / 1000;

  it("reports the remaining relay window", () => {
    const expiry = getOrderExpiry(nowSec + 3_900, nowMs);
    expect(expiry.expired).toBe(false);
    expect(expiry.secondsRemaining).toBe(3_900);
    expect(expiry.label).toBe("1h 05m");
  });

  it("flags a window that has already passed", () => {
    const expiry = getOrderExpiry(nowSec - 125, nowMs);
    expect(expiry.expired).toBe(true);
    expect(expiry.secondsRemaining).toBe(-125);
    expect(expiry.label).toBe("expired 2m 05s ago");
  });

  it("treats the exact expiry second as expired", () => {
    expect(getOrderExpiry(nowSec, nowMs).expired).toBe(true);
  });
});
