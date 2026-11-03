import { StrKey } from "@stellar/stellar-sdk";
import { STELLAR_MAINNET_CHAIN_ID } from "@lifi/intent";
import { bytesToHex } from "viem";
import { arbitrum, base, baseSepolia } from "viem/chains";

export const STELLAR_TESTNET_ID = 1201081091099711;

/**
 * Axelar oracle ABI generation.
 * - `legacy`: lifi-oif `e226659` / intent-soroban `5b8f3ca`; submit takes the destination name
 *   and a raw bytes32 recipient that the oracle encodes by route kind.
 * - `current`: lifi-oif `7dc19ce` / intent-soroban `dccd29f`; EVM submit takes the destination
 *   name, Stellar submit the numeric destination id, both a native recipient string.
 */
export type AxelarGeneration = "legacy" | "current";
export type AxelarEvmDeployment = {
  axelarName: string;
  oracle: `0x${string}`;
  usdc: `0x${string}`;
};
export type AxelarNetwork = {
  mainnet: boolean;
  generation: AxelarGeneration;
  estimatorUrl: string;
  /** Stellar contracts are C-strkeys. */
  stellar: {
    chainId: number;
    axelarName: string;
    oracle: string;
    inputEscrow: string;
    outputSettler: string;
    usdc: string;
  };
  /** Supported EVM counterparts of the Stellar chain, keyed by chain id. */
  evm: Partial<Record<number, AxelarEvmDeployment>>;
};

// Public deployment records, matching order-service `/api/v1/contracts` per network.
export const AXELAR_NETWORKS: { mainnet: AxelarNetwork; testnet: AxelarNetwork } = {
  mainnet: {
    mainnet: true,
    generation: "legacy",
    estimatorUrl: "https://api.axelarscan.io/gmp/estimateGasFeeForNHops",
    stellar: {
      chainId: Number(STELLAR_MAINNET_CHAIN_ID),
      axelarName: "stellar",
      oracle: "CAVJORXN3EOHH5GGHOK66YTPBUFNICWGSAO3UBUG6SS75VSMGWIEQX4V",
      inputEscrow: "CA5GTK5U5LYGWIJSAG6LD724NUDFONHVEHYOHOH5KWCKCX5I442QYLUN",
      outputSettler: "CBNYANRIUUUTAZJSEA2FEYUHFPUNRRYPUP6URIZIG2PZXTWWYSXLL3SX",
      usdc: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
    },
    evm: {
      [base.id]: {
        axelarName: "base",
        oracle: "0xb7eA767b54aF5Dd8AD12Df648A399F9075D93FeE",
        usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
      },
      [arbitrum.id]: {
        axelarName: "arbitrum",
        oracle: "0x86dd17B49ebcE5773b44490951BB80692D905BC9",
        usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
      }
    }
  },
  testnet: {
    mainnet: false,
    generation: "current",
    estimatorUrl: "https://testnet.api.axelarscan.io/gmp/estimateGasFeeForNHops",
    stellar: {
      chainId: STELLAR_TESTNET_ID,
      axelarName: "stellar-2026-q1-2",
      oracle: "CC7DG7L35SLE7MALNEG6QJAKG6GJNCQIIGVBA63HQ26XHEBRKBHO246J",
      inputEscrow: "CBA4VPFFOASNKUN4EXC2YLSIWCWUATLDVGVCSZP4ZLDTANGFE6KWXYV5",
      outputSettler: "CBH65VCEEAXLR2APAIMZVTWMGCHQ6N2ZIASI7NYQO4MIOPY4BWJR3TV5",
      usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
    },
    evm: {
      [baseSepolia.id]: {
        axelarName: "base-sepolia",
        oracle: "0x7bec62dd796b39ac36bbdc8a8470a77cae5c8716",
        usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
      }
    }
  }
};
const networks = [AXELAR_NETWORKS.mainnet, AXELAR_NETWORKS.testnet];

export function stellarContractHex(address: string) {
  return bytesToHex(StrKey.decodeContract(address));
}

export type AxelarCorridor = {
  network: AxelarNetwork;
  evmChainId: number;
  evm: AxelarEvmDeployment;
};
/** The supported Stellar ↔ EVM corridor between `a` and `b`, in either direction. */
export function findAxelarCorridor(
  a: number | bigint,
  b: number | bigint
): AxelarCorridor | undefined {
  for (const network of networks) {
    const stellar = network.stellar.chainId;
    const evmChainId =
      Number(a) === stellar ? Number(b) : Number(b) === stellar ? Number(a) : undefined;
    const evm = evmChainId === undefined ? undefined : network.evm[evmChainId];
    if (evm) return { network, evmChainId: evmChainId!, evm };
  }
  return undefined;
}
export function axelarCorridor(a: number | bigint, b: number | bigint): AxelarCorridor {
  const corridor = findAxelarCorridor(a, b);
  if (!corridor) throw new Error(`Unsupported Axelar corridor: ${a} ↔ ${b}`);
  return corridor;
}
/** Raw Stellar settler ids for the SDK's `getStellarDeployment` hook. */
export function stellarSettlers(chainId: bigint) {
  const network = networks.find(({ stellar }) => BigInt(stellar.chainId) === chainId);
  if (!network) return undefined;
  return {
    inputEscrow: stellarContractHex(network.stellar.inputEscrow),
    outputSettler: stellarContractHex(network.stellar.outputSettler)
  };
}
