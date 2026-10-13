import { addressToBytes32, bytes32ToAddress } from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import { base58 } from "@scure/base";
import { decodeEventLog, hexToBytes, keccak256, TransactionReceiptNotFoundError } from "viem";
import type { Hex, Log, PublicClient, TransactionReceipt } from "viem";
import {
  chainMetaById,
  getChain,
  getClient,
  WORMHOLE_CHAIN_IDS,
  WORMHOLE_CORE,
  WORMHOLE_ORACLE
} from "$lib/config";
import type { WC } from "$lib/config";
import { WORMHOLE_CORE_ABI } from "$lib/abi/wormholecore";
import { WORMHOLE_ORACLE_ABI } from "$lib/abi/wormholeoracle";
import { isSolanaChain, isTronChain } from "$lib/utils/chainType";
import { isValidTxRef } from "$lib/utils/txRef";
import { createSwitchWalletChain } from "$lib/utils/walletClient";
import {
  assertWormholeMessageId,
  assertWormholeVaa,
  decodeWormholeEnvelope,
  getSignedWormholeVaa
} from "./wormholeProof";
import type { WormholeExpectedMessage, WormholePublication } from "./wormholeProof";
import {
  findSolanaWormholePublication,
  verifySolanaWormholePublication
} from "./wormholeSolanaRecovery";

const PUBLICATION_EVENT = WORMHOLE_CORE_ABI[2];
const SCAN_BLOCKS = 50_000n;
const SCAN_CHUNK = 10_000n;
const MIN_CHUNK = 1_000n;
const TAGS: Record<string, true> = { "0xd1252dff": true, "0x830c1e1c": true };
const HISTORY_ERROR =
  "Wormhole publication history unavailable. Retry with an archival RPC or the publication transaction.";
const switchWalletChain = createSwitchWalletChain({
  getCurrentProvider: async () => {
    // SvelteKit's wagmi environment is unavailable in Bun proof-helper consumers.
    const { getCurrentProvider } = await import("$lib/utils/wagmi");
    return getCurrentProvider();
  }
});

type SourceDeployment = {
  chainId: number;
  oracle: Hex;
  emitter: Hex;
  emitterChain: number;
  network: "mainnet" | "testnet";
};
type EvmSourceDeployment = SourceDeployment & { core: Hex; client: PublicClient };
type PublicationCandidate = {
  publication: WormholePublication;
  blockNumber: bigint;
  logIndex: number;
};
type ScanCache = { through?: bigint; transactions: Map<Hex, bigint> };
// A replacement RPC cannot inherit the previous transport's scanned history.
const scanCaches = new WeakMap<object, Map<string, ScanCache>>();

function sourceDeployment(output: MandateOutput): SourceDeployment {
  const chainId = Number(output.chainId);
  const oracle = WORMHOLE_ORACLE[chainId];
  const emitterChain = WORMHOLE_CHAIN_IDS[chainId];
  const metadata = chainMetaById[chainId];
  if (
    !Number.isSafeInteger(chainId) ||
    !oracle ||
    !emitterChain ||
    !metadata ||
    isTronChain(chainId)
  ) {
    throw new Error(`Wormhole is unavailable on chain ${output.chainId}: no supported deployment.`);
  }
  const emitter = isSolanaChain(chainId) ? oracle : addressToBytes32(oracle);
  if (output.oracle.toLowerCase() !== emitter.toLowerCase()) {
    throw new Error("Wormhole publication oracle does not match the source deployment.");
  }
  return {
    chainId,
    oracle,
    emitter,
    emitterChain,
    network: metadata.testnet ? "testnet" : "mainnet"
  };
}

function evmSource(output: MandateOutput): EvmSourceDeployment {
  const source = sourceDeployment(output);
  const core = WORMHOLE_CORE[source.chainId];
  if (isSolanaChain(source.chainId) || !core || !/^0x[0-9a-f]{40}$/i.test(core)) {
    throw new Error("Wormhole EVM Core is unavailable on the output chain.");
  }
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(output.settler)) {
    throw new Error("Wormhole application must be a clean bytes32 EVM address.");
  }
  return { ...source, core, client: getClient(source.chainId) as PublicClient };
}

function assertExpected(output: MandateOutput, expected: WormholeExpectedMessage): void {
  if (
    !/^0x[0-9a-f]{64}$/i.test(expected.application) ||
    expected.application.toLowerCase() !== output.settler.toLowerCase() ||
    !/^0x(?:[0-9a-f]{2})+$/i.test(expected.payload) ||
    !TAGS[expected.payload.slice(0, 10).toLowerCase()] ||
    (expected.payload.length - 2) / 2 > 65535
  ) {
    throw new Error(
      "Expected the output settler and a current tagged OIF fill or non-fill payload."
    );
  }
}

function matchesEnvelope(payload: Hex, expected: WormholeExpectedMessage): boolean {
  try {
    const envelope = decodeWormholeEnvelope(hexToBytes(payload));
    return (
      envelope.application.toLowerCase() === expected.application.toLowerCase() &&
      envelope.payloads.some((item) => item.toLowerCase() === expected.payload.toLowerCase())
    );
  } catch {
    return false;
  }
}

function publicationFromLog(
  source: EvmSourceDeployment,
  log: Log,
  expected: WormholeExpectedMessage
): WormholePublication | null {
  if (log.removed || log.address.toLowerCase() !== source.core.toLowerCase()) return null;
  let decoded;
  try {
    decoded = decodeEventLog({
      abi: WORMHOLE_CORE_ABI,
      eventName: "LogMessagePublished",
      data: log.data,
      topics: log.topics
    });
  } catch {
    return null;
  }
  const { sender, sequence, nonce, payload, consistencyLevel } = decoded.args;
  if (
    sender.toLowerCase() !== source.oracle.toLowerCase() ||
    nonce !== 0 ||
    consistencyLevel !== 15 ||
    !matchesEnvelope(payload, expected)
  )
    return null;
  return {
    id: {
      network: source.network,
      emitterChain: source.emitterChain,
      emitter: source.emitter,
      sequence: sequence.toString()
    },
    nonce,
    consistencyLevel,
    txRef: log.transactionHash ?? undefined
  };
}

function receiptCandidate(
  source: EvmSourceDeployment,
  receipt: TransactionReceipt,
  expected: WormholeExpectedMessage
): PublicationCandidate | null {
  if (receipt.status !== "success") return null;
  const matches = receipt.logs.flatMap((log) => {
    const publication = publicationFromLog(source, log, expected);
    return publication
      ? [
          {
            publication: { ...publication, txRef: receipt.transactionHash },
            blockNumber: receipt.blockNumber,
            logIndex: log.logIndex
          }
        ]
      : [];
  });
  if (matches.length > 1)
    throw new Error(
      "Ambiguous Wormhole publication: multiple matching Core logs in one transaction."
    );
  return matches[0] ?? null;
}

async function readReceiptCandidate(
  source: EvmSourceDeployment,
  hash: Hex,
  expected: WormholeExpectedMessage
): Promise<PublicationCandidate | null> {
  let receipt: TransactionReceipt;
  try {
    receipt = await source.client.getTransactionReceipt({ hash });
  } catch (cause) {
    if (cause instanceof TransactionReceiptNotFoundError) return null;
    throw new Error(HISTORY_ERROR, { cause });
  }
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) return null;
  return receiptCandidate(source, receipt, expected);
}

async function assertSourceRpc(source: EvmSourceDeployment): Promise<void> {
  if ((await source.client.getChainId()) !== source.chainId) {
    throw new Error(
      "Wormhole publication RPC serves a different output chain. Retry with the correct RPC."
    );
  }
}

async function assertWallet(
  source: EvmSourceDeployment,
  walletClient: WC,
  account: Hex
): Promise<void> {
  if ((await walletClient.getChainId()) !== source.chainId) {
    throw new Error(
      `Switch your wallet to output chain ${source.chainId} before publishing Wormhole.`
    );
  }
  if (
    !/^0x[0-9a-f]{40}$/i.test(account) ||
    !(await walletClient.getAddresses()).some(
      (address) => address.toLowerCase() === account.toLowerCase()
    )
  ) {
    throw new Error("Wormhole publication account is not connected to the output wallet.");
  }
}

/** Publishes one existing SDK-encoded payload; the submit return value is not a sequence. */
export async function publishEvmWormhole(
  output: MandateOutput,
  payload: Hex,
  walletClient: WC,
  account: Hex,
  opts?: { beforeSpend?: () => Promise<void> }
): Promise<WormholePublication> {
  const expected = { application: output.settler, payload };
  assertExpected(output, expected);
  const source = evmSource(output);
  await assertSourceRpc(source);
  if ((await walletClient.getChainId()) !== source.chainId) {
    await switchWalletChain(walletClient, source.chainId);
  }
  await assertWallet(source, walletClient, account);
  const configuredCore = await source.client.readContract({
    address: source.oracle,
    abi: WORMHOLE_ORACLE_ABI,
    functionName: "WORMHOLE"
  });
  const nativeChainId = await source.client.readContract({
    address: source.core,
    abi: WORMHOLE_CORE_ABI,
    functionName: "chainId"
  });
  if (
    configuredCore.toLowerCase() !== source.core.toLowerCase() ||
    nativeChainId !== source.emitterChain
  ) {
    throw new Error("Wormhole source oracle/Core deployment identity mismatch.");
  }
  const fee = await source.client.readContract({
    address: source.core,
    abi: WORMHOLE_CORE_ABI,
    functionName: "messageFee"
  });
  const { request } = await source.client.simulateContract({
    address: source.oracle,
    abi: WORMHOLE_ORACLE_ABI,
    functionName: "submit",
    args: [bytes32ToAddress(output.settler), [payload]],
    account,
    value: fee
  });
  // Wallet state may have changed while the RPC simulated the publication.
  await assertWallet(source, walletClient, account);
  await opts?.beforeSpend?.();
  const hash = await walletClient.writeContract({ ...request, chain: getChain(source.chainId) });
  const receipt = await source.client.waitForTransactionReceipt({
    hash,
    timeout: 120_000,
    pollingInterval: 2_000
  });
  if (receipt.status !== "success") throw new Error("Wormhole publication transaction reverted.");
  const candidate = receiptCandidate(source, receipt, expected);
  if (!candidate) throw new Error("Wormhole publication transaction has no matching Core message.");
  saveWormholeHint(output, expected, candidate.publication);
  return candidate.publication;
}

function hintKey(output: MandateOutput, expected: WormholeExpectedMessage): string {
  return `lintent.wormhole.v1.${output.chainId}.${output.oracle.toLowerCase()}.${expected.application.toLowerCase()}.${keccak256(expected.payload)}`;
}

function cleanHint(
  output: MandateOutput,
  expected: WormholeExpectedMessage,
  value: unknown
): WormholePublication | null {
  try {
    assertExpected(output, expected);
    const source = sourceDeployment(output);
    if (!value || typeof value !== "object") return null;
    const hint = value as WormholePublication;
    assertWormholeMessageId(hint.id);
    if (
      hint.id.network !== source.network ||
      hint.id.emitterChain !== source.emitterChain ||
      hint.id.emitter.toLowerCase() !== source.emitter.toLowerCase() ||
      !Number.isInteger(hint.nonce) ||
      hint.nonce < 0 ||
      hint.nonce > 0xffffffff ||
      !Number.isInteger(hint.consistencyLevel) ||
      hint.consistencyLevel < 0 ||
      hint.consistencyLevel > 255 ||
      (hint.txRef !== undefined && !isValidTxRef(hint.txRef, output.chainId))
    )
      return null;
    if (
      hint.messageAccount !== undefined &&
      (!isSolanaChain(output.chainId) || base58.decode(hint.messageAccount).length !== 32)
    )
      return null;
    return {
      id: {
        network: hint.id.network,
        emitterChain: hint.id.emitterChain,
        emitter: hint.id.emitter.toLowerCase() as Hex,
        sequence: hint.id.sequence
      },
      nonce: hint.nonce,
      consistencyLevel: hint.consistencyLevel,
      ...(hint.txRef ? { txRef: hint.txRef } : {}),
      ...(hint.messageAccount ? { messageAccount: hint.messageAccount } : {})
    };
  } catch {
    return null;
  }
}

/** Hints are locators only. Every consumer must rediscover or verify them against chain data. */
export function loadWormholeHint(
  output: MandateOutput,
  expected: WormholeExpectedMessage
): WormholePublication | undefined {
  try {
    const stored = localStorage.getItem(hintKey(output, expected));
    return stored ? (cleanHint(output, expected, JSON.parse(stored)) ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

export function saveWormholeHint(
  output: MandateOutput,
  expected: WormholeExpectedMessage,
  publication: WormholePublication
): void {
  try {
    const hint = cleanHint(output, expected, publication);
    if (hint) localStorage.setItem(hintKey(output, expected), JSON.stringify(hint));
  } catch {
    // Storage is best-effort, including unavailable browser storage and quota failures.
  }
}

/** Save the fresh public locator before signing; a sequence does not exist yet. */
export function saveWormholeMessageAccount(
  output: MandateOutput,
  expected: WormholeExpectedMessage,
  messageAccount: string
): void {
  try {
    assertExpected(output, expected);
    sourceDeployment(output);
    if (!isSolanaChain(output.chainId) || base58.decode(messageAccount).length !== 32) return;
    localStorage.setItem(hintKey(output, expected), JSON.stringify({ messageAccount }));
  } catch {
    // A missing or unavailable storage facility must not prevent publication.
  }
}

function readWormholeMessageAccount(
  output: MandateOutput,
  expected: WormholeExpectedMessage
): string | undefined {
  try {
    if (!isSolanaChain(output.chainId)) return undefined;
    const stored = localStorage.getItem(hintKey(output, expected));
    if (!stored) return undefined;
    const locator: unknown = JSON.parse(stored);
    if (
      !locator ||
      typeof locator !== "object" ||
      !("messageAccount" in locator) ||
      typeof locator.messageAccount !== "string" ||
      base58.decode(locator.messageAccount).length !== 32
    )
      return undefined;
    return locator.messageAccount;
  } catch {
    return undefined;
  }
}

export function clearWormholeHint(output: MandateOutput, expected: WormholeExpectedMessage): void {
  try {
    localStorage.removeItem(hintKey(output, expected));
  } catch {
    /* Best-effort. */
  }
}

function sameIdentity(left: WormholePublication, right: WormholePublication): boolean {
  return (
    left.id.network === right.id.network &&
    left.id.emitterChain === right.id.emitterChain &&
    left.id.emitter.toLowerCase() === right.id.emitter.toLowerCase() &&
    left.id.sequence === right.id.sequence
  );
}

/** Re-derive publication metadata, never treating stored nonce/consistency as authoritative. */
export async function verifyWormholePublication(
  output: MandateOutput,
  expected: WormholeExpectedMessage,
  publication: WormholePublication
): Promise<WormholePublication | null> {
  assertExpected(output, expected);
  const hint = cleanHint(output, expected, publication);
  if (!hint) return null;
  if (isSolanaChain(output.chainId)) return verifySolanaWormholePublication(output, expected, hint);
  const source = evmSource(output);
  await assertSourceRpc(source);
  if (!hint.txRef) return null;
  const candidate = await readReceiptCandidate(source, hint.txRef as Hex, expected);
  return candidate && sameIdentity(candidate.publication, hint) ? candidate.publication : null;
}

async function findEvmPublication(
  output: MandateOutput,
  expected: WormholeExpectedMessage,
  hint?: WormholePublication
): Promise<WormholePublication | null> {
  const source = evmSource(output);
  await assertSourceRpc(source);
  const candidates = new Map<Hex, PublicationCandidate>();
  if (hint?.txRef) {
    const candidate = await readReceiptCandidate(source, hint.txRef as Hex, expected);
    // The receipt independently binds the exact application/payload. Rediscover
    // its actual identity even when a locator's stored sequence was corrupted.
    if (candidate) candidates.set(hint.txRef as Hex, candidate);
  }
  let caches = scanCaches.get(source.client);
  if (!caches) {
    caches = new Map();
    scanCaches.set(source.client, caches);
  }
  const key = `${source.network}.${source.core.toLowerCase()}.${hintKey(output, expected)}`;
  let cache = caches.get(key);
  if (!cache) {
    cache = { transactions: new Map() };
    caches.set(key, cache);
  }
  let latest: bigint;
  try {
    latest = await source.client.getBlockNumber();
  } catch (cause) {
    throw new Error(HISTORY_ERROR, { cause });
  }
  // An RPC rewind must not preserve a scanned-through height from the abandoned branch.
  if (cache.through !== undefined && latest < cache.through) {
    cache.through = undefined;
    cache.transactions.clear();
  }
  const windowFloor = latest >= SCAN_BLOCKS ? latest - SCAN_BLOCKS + 1n : 0n;
  const floor =
    cache.through !== undefined && cache.through + 1n > windowFloor
      ? cache.through + 1n
      : windowFloor;
  let toBlock = latest;
  let chunk = SCAN_CHUNK;
  while (toBlock >= floor) {
    const fromBlock = toBlock - chunk + 1n > floor ? toBlock - chunk + 1n : floor;
    let logs: Log[];
    try {
      logs = await source.client.getLogs<typeof PUBLICATION_EVENT>({
        address: source.core,
        event: PUBLICATION_EVENT,
        args: { sender: source.oracle },
        fromBlock,
        toBlock
      });
    } catch (cause) {
      if (chunk === MIN_CHUNK) throw new Error(HISTORY_ERROR, { cause });
      chunk = chunk / 2n < MIN_CHUNK ? MIN_CHUNK : chunk / 2n;
      continue;
    }
    for (const log of logs) {
      if (
        log.transactionHash &&
        log.blockNumber !== null &&
        publicationFromLog(source, log, expected)
      ) {
        cache.transactions.set(log.transactionHash, log.blockNumber);
      }
    }
    toBlock = fromBlock - 1n;
  }
  cache.through = latest;
  for (const [hash, blockNumber] of cache.transactions) {
    // Retain matching publications across refreshes, but refresh their receipt authority.
    if (blockNumber > latest) {
      cache.transactions.delete(hash);
      continue;
    }
    if (!candidates.has(hash)) {
      const candidate = await readReceiptCandidate(source, hash, expected);
      if (candidate) candidates.set(hash, candidate);
      else cache.transactions.delete(hash);
    }
  }
  const ordered = [...candidates.values()].sort((left, right) =>
    left.blockNumber > right.blockNumber
      ? -1
      : left.blockNumber < right.blockNumber
        ? 1
        : right.logIndex - left.logIndex
  );
  for (const candidate of ordered) {
    const signed = await getSignedWormholeVaa(candidate.publication.id);
    if (signed.status === "vaa") {
      assertWormholeVaa(signed.bytes, candidate.publication, expected);
      return candidate.publication;
    }
  }
  return ordered[0]?.publication ?? null;
}

/** Discover every eligible publication before choosing newest signed, otherwise newest verified. */
export async function findWormholePublication(
  output: MandateOutput,
  expected: WormholeExpectedMessage,
  hint?: WormholePublication
): Promise<WormholePublication | null> {
  assertExpected(output, expected);
  sourceDeployment(output);
  const trustedShape = cleanHint(output, expected, hint) ?? loadWormholeHint(output, expected);
  const publication = isSolanaChain(output.chainId)
    ? await findSolanaWormholePublication(
        output,
        expected,
        trustedShape,
        readWormholeMessageAccount(output, expected)
      )
    : await findEvmPublication(output, expected, trustedShape);
  if (publication) saveWormholeHint(output, expected, publication);
  return publication;
}
