import { PublicKey } from "@solana/web3.js";
import { addressToBytes32, type MandateOutput, type OrderContainer } from "@lifi/intent";
import { BaseError, bytesToHex, type Hex, type PublicClient } from "viem";
import {
  chainMetaById,
  COIN_FILLER,
  getClient,
  SOLANA_OUTPUT_SETTLER,
  SOLANA_WORMHOLE_CORE,
  WORMHOLE_CHAIN_IDS,
  WORMHOLE_CORE,
  WORMHOLE_ORACLE,
  type Verifier
} from "$lib/config";
import { WORMHOLE_ORACLE_ABI } from "$lib/abi/wormholeoracle";
import { WORMHOLE_CORE_ABI } from "$lib/abi/wormholecore";
import { OUTPUT_SETTLER_SIMPLE_PROGRAM_ID, WORMHOLE_PROGRAM_ID } from "$lib/idl";
import { getSolanaReads, SOLANA_GENESIS_HASHES } from "$lib/solana/client";
import { bytes32ToPubkey, wormholeOraclePda } from "$lib/solana/pda";
import { readChainMappingCanonicalId } from "$lib/solana/reads";
import type { SolanaConnectionLike } from "$lib/solana/types";
import { isSolanaChain, isTronChain } from "$lib/utils/chainType";
import { polymerOraclesFor } from "./polymerReceive";

// Mainnet's only supported Solana deployment. Devnet is deliberately not an alias.
const WORMHOLE_STATE_DISCRIMINATOR = [0xda, 0xcf, 0xee, 0xbe, 0x62, 0xa3, 0x03, 0xc7];

type Readiness = { ready: true } | { ready: false; reason: string };
export type WormholeRouteOutput = Pick<MandateOutput, "chainId" | "oracle" | "settler">;
type WormholeCandidate = {
  chainId: bigint;
  oracle: Hex;
  nativeId: number;
  network: "mainnet" | "testnet";
};
type Deployment = WormholeCandidate &
  (
    | {
        kind: "evm";
        core: Hex;
        reads: Pick<PublicClient, "getChainId" | "getBytecode" | "readContract">;
      }
    | { kind: "solana"; core: string; reads: SolanaConnectionLike }
  );

/** Reject dirty bytes32 EVM identities rather than silently truncating their high bytes. */
function normalizedOracle(chainId: number | bigint, value: Hex): string | undefined {
  if (isSolanaChain(chainId)) {
    return /^0x[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined;
  }
  if (/^0x[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  if (/^0x0{24}[0-9a-f]{40}$/i.test(value)) return `0x${value.slice(-40)}`.toLowerCase();
  return undefined;
}

/** A recorded oracle, never the UI's currently selected verifier, determines the provider. */
export function oracleProviderFor(
  chainId: number | bigint,
  inputOracle: Hex
): Verifier | undefined {
  const identity = normalizedOracle(chainId, inputOracle);
  if (!identity) return undefined;
  const wormhole = WORMHOLE_ORACLE[Number(chainId)];
  if (wormhole && identity === normalizedOracle(chainId, wormhole)) return "wormhole";
  if (
    [...polymerOraclesFor(chainId)].some(
      (oracle) => identity === normalizedOracle(chainId, oracle as Hex)
    )
  ) {
    return "polymer";
  }
  return undefined;
}

function requireReady(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function candidate(chainId: bigint): WormholeCandidate {
  const id = Number(chainId);
  const oracle = WORMHOLE_ORACLE[id];
  const nativeId = WORMHOLE_CHAIN_IDS[id];
  const metadata = chainMetaById[id];
  requireReady(
    Number.isSafeInteger(id) && !!oracle && !!nativeId && !!metadata && !isTronChain(chainId),
    `Wormhole is unavailable on chain ${chainId}: no supported deployment.`
  );
  return {
    chainId,
    oracle: oracle!,
    nativeId: nativeId!,
    network: metadata!.testnet ? "testnet" : "mainnet"
  };
}

async function deployment(value: WormholeCandidate): Promise<Deployment> {
  if (isSolanaChain(value.chainId)) {
    requireReady(
      value.network === "mainnet" && value.nativeId === 1,
      "Wormhole Solana devnet is unavailable."
    );
    return {
      ...value,
      kind: "solana",
      core: SOLANA_WORMHOLE_CORE,
      reads: await getSolanaReads(value.chainId)
    };
  }
  const core = WORMHOLE_CORE[Number(value.chainId)];
  requireReady(
    !!core && /^0x[0-9a-f]{40}$/i.test(core),
    `Wormhole Core is unavailable on chain ${value.chainId}.`
  );
  return { ...value, kind: "evm", core: core!, reads: getClient(value.chainId) };
}

// Keep immutable successes scoped to the actual read clients as well as the full
// deployment/route identity. Replacing a transport cannot inherit another one's checks.
const successfulRoutes = new WeakMap<object, Set<string>>();
const readIds = new WeakMap<object, number>();
let nextReadId = 0;
function readIdentity(reads: object): number {
  let id = readIds.get(reads);
  if (id === undefined) {
    id = ++nextReadId;
    readIds.set(reads, id);
  }
  return id;
}
function routeIdentity(input: Deployment, output: Deployment, settler: Hex): string {
  return (
    [input, output]
      .map(
        (value) =>
          `${value.chainId}:${value.oracle.toLowerCase()}:${value.core.toLowerCase()}:${value.nativeId}:${value.network}:${readIdentity(value.reads)}`
      )
      .join("/") + `/${settler.toLowerCase()}`
  );
}

/** Never cache actual RPC identity: a client can retain its object while its transport changes. */
async function assertRpcIdentity(value: Deployment): Promise<void> {
  if (value.kind === "evm") {
    requireReady(
      BigInt(await value.reads.getChainId()) === value.chainId,
      `Wormhole unavailable: RPC serves a different chain than ${value.chainId}. Retry with the correct RPC.`
    );
  } else {
    requireReady(
      (await value.reads.getGenesisHash()) === SOLANA_GENESIS_HASHES[value.chainId.toString()],
      `Wormhole unavailable: Solana RPC serves a different cluster. Retry with the correct RPC.`
    );
  }
}

async function assertDeployment(value: Deployment): Promise<void> {
  if (value.kind === "evm") {
    for (const address of [value.oracle, value.core, COIN_FILLER]) {
      const code = await value.reads.getBytecode({ address });
      requireReady(
        !!code && code !== "0x",
        `Wormhole unavailable: no executable code at ${address} on chain ${value.chainId}.`
      );
    }
    const core = await value.reads.readContract({
      address: value.oracle,
      abi: WORMHOLE_ORACLE_ABI,
      functionName: "WORMHOLE"
    });
    requireReady(
      core.toLowerCase() === value.core.toLowerCase(),
      `Wormhole unavailable: oracle Core mismatch on chain ${value.chainId}.`
    );
    const nativeId = await value.reads.readContract({
      address: value.core,
      abi: WORMHOLE_CORE_ABI,
      functionName: "chainId"
    });
    requireReady(
      Number(nativeId) === value.nativeId,
      `Wormhole unavailable: Core native chain ID mismatch on chain ${value.chainId}.`
    );
    return;
  }

  for (const address of [WORMHOLE_PROGRAM_ID, value.core, OUTPUT_SETTLER_SIMPLE_PROGRAM_ID]) {
    const program = await value.reads.getAccountInfo(address, "confirmed");
    requireReady(
      program?.executable === true,
      `Wormhole unavailable: Solana program ${address} is not executable.`
    );
  }
  const stateAddress = bytes32ToPubkey(value.oracle).toBase58();
  const [expectedState, expectedBump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("wormhole")],
    new PublicKey(WORMHOLE_PROGRAM_ID)
  );
  requireReady(
    stateAddress === wormholeOraclePda().toBase58() && expectedState.equals(wormholeOraclePda()),
    "Wormhole unavailable: Solana oracle must be the program's state PDA."
  );
  const state = await value.reads.getAccountInfo(stateAddress, "confirmed");
  requireReady(
    state?.owner === WORMHOLE_PROGRAM_ID &&
      state.data.length === 89 &&
      WORMHOLE_STATE_DISCRIMINATOR.every((byte, index) => state.data[index] === byte) &&
      state.data[88] === expectedBump,
    "Wormhole unavailable: Solana oracle state owner or layout mismatch."
  );
  requireReady(
    bytes32ToPubkey(bytesToHex(state!.data.subarray(40, 72))).toBase58() === value.core,
    "Wormhole unavailable: Solana oracle Core mismatch."
  );
  let canonicalId = 0n;
  for (let index = 87; index >= 72; index--)
    canonicalId = (canonicalId << 8n) | BigInt(state!.data[index]!);
  requireReady(
    canonicalId === value.chainId,
    "Wormhole unavailable: Solana oracle canonical chain ID mismatch."
  );
  const settler = await value.reads.getAccountInfo(
    bytes32ToPubkey(SOLANA_OUTPUT_SETTLER).toBase58(),
    "confirmed"
  );
  requireReady(
    settler?.owner === OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
    "Wormhole unavailable: Solana output settler state is missing or foreign-owned."
  );
}

async function assertMapping(input: Deployment, output: Deployment): Promise<void> {
  if (input.kind === "evm") {
    const forward = await input.reads.readContract({
      address: input.oracle,
      abi: WORMHOLE_ORACLE_ABI,
      functionName: "chainIdMap",
      args: [BigInt(output.nativeId)]
    });
    const reverse = await input.reads.readContract({
      address: input.oracle,
      abi: WORMHOLE_ORACLE_ABI,
      functionName: "reverseChainIdMap",
      args: [output.chainId]
    });
    requireReady(
      forward === output.chainId && reverse === BigInt(output.nativeId),
      `Wormhole unavailable: exact bidirectional chain mapping ${input.chainId} → ${output.chainId} is not configured.`
    );
  } else {
    const canonicalId = await readChainMappingCanonicalId(
      input.reads,
      bytes32ToPubkey(input.oracle).toBase58(),
      BigInt(output.nativeId)
    );
    requireReady(
      canonicalId === output.chainId,
      `Wormhole unavailable: protocol-owned Solana mapping to chain ${output.chainId} is missing or incompatible.`
    );
  }
}
function unavailableReason(error: unknown): string {
  const detail =
    error instanceof BaseError
      ? error.shortMessage
      : error instanceof Error
        ? error.message
        : String(error);
  return `${detail} Wormhole route unavailable; retry after checking the deployment or RPC.`;
}

/** Read-only issuance checks need deployment identities, not connected wallet accounts. */
export async function assertWormholeSelectionReady(
  inputChainIds: readonly number[],
  outputChainIds: readonly number[],
  verifier: Verifier
): Promise<void> {
  if (verifier !== "wormhole") return;
  const inputChains = [...new Set(inputChainIds)];
  const outputChains = [...new Set(outputChainIds)];
  if (inputChains.every((input) => outputChains.every((output) => input === output))) return;
  if (inputChains.length > 1) {
    const globalOracle = WORMHOLE_ORACLE[inputChains[0]!];
    requireReady(
      !!globalOracle &&
        inputChains.every((chainId) => oracleProviderFor(chainId, globalOracle) === "wormhole"),
      "Wormhole multichain inputs require the same oracle address on every input chain."
    );
  }
  for (const inputChainId of inputChains) {
    let input: WormholeCandidate;
    try {
      input = candidate(BigInt(inputChainId));
    } catch (error) {
      throw new Error(unavailableReason(error));
    }
    for (const outputChainId of outputChains) {
      if (inputChainId === outputChainId) continue;
      let output: WormholeCandidate;
      try {
        output = candidate(BigInt(outputChainId));
      } catch (error) {
        throw new Error(unavailableReason(error));
      }
      const result = await checkWormholeRoute(input.chainId, input.oracle, {
        chainId: output.chainId,
        oracle: isSolanaChain(output.chainId) ? output.oracle : addressToBytes32(output.oracle),
        settler: isSolanaChain(output.chainId)
          ? SOLANA_OUTPUT_SETTLER
          : addressToBytes32(COIN_FILLER)
      });
      if (!result.ready) throw new Error(result.reason);
    }
  }
}

/** Checks immutable deployment compatibility. Fees and proof/fill state remain uncached elsewhere. */
export async function checkWormholeRoute(
  inputChainId: bigint,
  inputOracle: Hex,
  output: WormholeRouteOutput
): Promise<Readiness> {
  if (inputChainId === output.chainId) return { ready: true };
  try {
    const inputCandidate = candidate(inputChainId);
    const outputCandidate = candidate(output.chainId);
    requireReady(
      inputCandidate.network === outputCandidate.network,
      "Wormhole input and output must use the same network."
    );
    requireReady(
      oracleProviderFor(inputChainId, inputOracle) === "wormhole",
      `Wormhole input oracle does not match chain ${inputChainId}'s deployment.`
    );
    const expectedOracle = isSolanaChain(output.chainId)
      ? outputCandidate.oracle
      : addressToBytes32(outputCandidate.oracle);
    requireReady(
      output.oracle.toLowerCase() === expectedOracle.toLowerCase(),
      `Wormhole output oracle does not match chain ${output.chainId}'s deployment.`
    );
    const expectedSettler = isSolanaChain(output.chainId)
      ? SOLANA_OUTPUT_SETTLER
      : addressToBytes32(COIN_FILLER);
    requireReady(
      output.settler.toLowerCase() === expectedSettler.toLowerCase(),
      `Wormhole output settler does not match chain ${output.chainId}'s deployment.`
    );

    const [inputDeployment, outputDeployment] = await Promise.all([
      deployment(inputCandidate),
      deployment(outputCandidate)
    ]);
    await Promise.all([assertRpcIdentity(inputDeployment), assertRpcIdentity(outputDeployment)]);
    const key = routeIdentity(inputDeployment, outputDeployment, output.settler);
    if (successfulRoutes.get(inputDeployment.reads)?.has(key)) return { ready: true };
    await Promise.all([assertDeployment(inputDeployment), assertDeployment(outputDeployment)]);
    await assertMapping(inputDeployment, outputDeployment);
    let successes = successfulRoutes.get(inputDeployment.reads);
    if (!successes) {
      successes = new Set();
      successfulRoutes.set(inputDeployment.reads, successes);
    }
    successes.add(key);
    return { ready: true };
  } catch (error) {
    return { ready: false, reason: unavailableReason(error) };
  }
}

/** Applies one recorded global oracle to every input × remote-output route. */
export async function assertWormholeOrderReady(container: OrderContainer): Promise<void> {
  const { order } = container;
  const inputChains =
    "originChainId" in order ? [order.originChainId] : order.inputs.map((input) => input.chainId);
  if (inputChains.every((chainId) => order.outputs.every((output) => output.chainId === chainId)))
    return;
  const usesWormhole =
    inputChains.some((chainId) => oracleProviderFor(chainId, order.inputOracle) === "wormhole") ||
    Object.entries(WORMHOLE_ORACLE).some(([chainId, oracle]) => {
      const identity = normalizedOracle(Number(chainId), order.inputOracle);
      return !!identity && !!oracle && identity === normalizedOracle(Number(chainId), oracle);
    });
  if (!usesWormhole) return;
  if (inputChains.length > 1) {
    requireReady(
      inputChains.every((chainId) => oracleProviderFor(chainId, order.inputOracle) === "wormhole"),
      "Wormhole multichain inputs require the same oracle address on every input chain."
    );
  }
  for (const chainId of inputChains) {
    for (const output of order.outputs) {
      const result = await checkWormholeRoute(chainId, order.inputOracle, output);
      if (!result.ready) throw new Error(result.reason);
    }
  }
}
