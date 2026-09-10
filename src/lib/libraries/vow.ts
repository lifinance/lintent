import {
  concatHex,
  compactSignatureToSignature,
  sliceHex,
  encodePacked,
  hashTypedData,
  isHex,
  keccak256,
  recoverAddress,
  size,
  toHex,
  type Address,
  type Hex
} from "viem";

export const VOW_TYPES = {
  Vow: [
    { name: "chainId", type: "uint256" },
    { name: "rootBlockNumber", type: "uint256" },
    { name: "root", type: "bytes32" }
  ]
} as const;

export type VowEvent = { emitter: Address; topics: Hex[]; data: Hex };
export type VowWitness = {
  signer: Address;
  chainId: string;
  latestBlockNumber?: number;
  rootBlockNumber: number;
  root: Hex;
  blockHash: Hex;
  proof: Hex[];
  signature: Hex;
  event: VowEvent;
};
export type VowFillLog = VowEvent & {
  chainId: number | bigint;
  blockNumber: bigint;
  blockHash: Hex;
  logIndex: number;
};

function requireHex(value: unknown, bytes?: number): asserts value is Hex {
  if (
    typeof value !== "string" ||
    !isHex(value, { strict: true }) ||
    value.length % 2 !== 0 ||
    (bytes !== undefined && size(value) !== bytes)
  ) {
    throw new Error(`Invalid Vow hex${bytes === undefined ? "" : `: expected ${bytes} bytes`}`);
  }
}

export function encodeVowEvent(event: VowEvent): Hex {
  requireHex(event.emitter, 20);
  requireHex(event.data);
  if (!Array.isArray(event.topics) || event.topics.length > 4)
    throw new Error("Invalid Vow topics");
  for (const topic of event.topics) requireHex(topic, 32);
  return concatHex([
    "0x01",
    event.emitter,
    toHex(event.topics.length, { size: 1 }),
    ...event.topics,
    event.data
  ]);
}

export async function validateAndEncodeVow(
  witness: VowWitness,
  expected: VowFillLog,
  signerIndex: number
): Promise<Hex> {
  if (!Number.isInteger(signerIndex) || signerIndex < 1 || signerIndex > 255) {
    throw new Error("Vow signer index must be in 1..255");
  }
  if (
    witness.chainId !== `eip155:${expected.chainId}` ||
    !Number.isSafeInteger(witness.rootBlockNumber) ||
    witness.rootBlockNumber < 0 ||
    BigInt(witness.rootBlockNumber) !== expected.blockNumber
  ) {
    throw new Error("Vow witness chain or block mismatch");
  }
  requireHex(witness.blockHash, 32);
  requireHex(witness.root, 32);
  requireHex(witness.signer, 20);
  requireHex(witness.signature);
  if (witness.blockHash.toLowerCase() !== expected.blockHash.toLowerCase()) {
    throw new Error("Vow witness block hash mismatch");
  }
  if (![64, 65].includes(size(witness.signature))) throw new Error("Invalid Vow signature length");
  const event = encodeVowEvent(witness.event);
  if (event.toLowerCase() !== encodeVowEvent(expected).toLowerCase()) {
    throw new Error("Vow witness event mismatch");
  }
  if (size(event) > 0xffff) throw new Error("Vow event is too large");
  if (!Array.isArray(witness.proof) || witness.proof.length > 255)
    throw new Error("Invalid Vow proof length");
  let root = keccak256(keccak256(event));
  for (const sibling of witness.proof) {
    requireHex(sibling, 32);
    root = keccak256(
      concatHex(BigInt(root) <= BigInt(sibling) ? [root, sibling] : [sibling, root])
    );
  }
  if (root.toLowerCase() !== witness.root.toLowerCase())
    throw new Error("Vow Merkle proof mismatch");
  const hash = hashTypedData({
    domain: {},
    types: VOW_TYPES,
    primaryType: "Vow",
    message: {
      chainId: BigInt(expected.chainId),
      rootBlockNumber: expected.blockNumber,
      root: witness.root
    }
  });
  const signature =
    size(witness.signature) === 64
      ? compactSignatureToSignature({
          r: sliceHex(witness.signature, 0, 32),
          yParityAndS: sliceHex(witness.signature, 32, 64)
        })
      : witness.signature;
  const signer = await recoverAddress({ hash, signature });
  if (signer.toLowerCase() !== witness.signer.toLowerCase())
    throw new Error("Vow signature signer mismatch");
  return concatHex([
    encodePacked(
      ["uint256", "uint256", "uint8", "uint8", "uint16"],
      [BigInt(expected.chainId), expected.blockNumber, witness.proof.length, 1, size(event)]
    ),
    ...witness.proof,
    encodePacked(["uint8", "uint16"], [signerIndex, size(witness.signature)]),
    witness.signature,
    event
  ]);
}

export async function pollVowWitness(
  log: Pick<VowFillLog, "chainId" | "blockNumber" | "logIndex">,
  options: { fetch?: typeof fetch; timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ witness: VowWitness; signerIndex: number }> {
  const fetchWitness = options.fetch ?? globalThis.fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    let response: Response | undefined;
    try {
      response = await fetchWitness("/vow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chainId: Number(log.chainId),
          blockNumber: log.blockNumber.toString(),
          logIndex: log.logIndex
        }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now())))
      });
    } catch {
      // Connection failures are retryable within this attempt's deadline.
    }
    if (response && response.status !== 429 && response.status < 500) {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Vow request failed (${response.status})`);
      if (body.status === "ready") {
        if (!body.witness || !Number.isInteger(body.signerIndex))
          throw new Error("Invalid ready Vow response");
        return { witness: body.witness, signerIndex: body.signerIndex };
      }
      if (body.status !== "pending" && body.status !== "indexing") {
        throw new Error(body.error ?? "Vow witness failed");
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(options.intervalMs ?? 2000, remaining))
      );
  }
  throw new Error("Vow witness is not ready yet. Retry once the fill has been indexed.");
}
