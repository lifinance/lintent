import { StrKey } from "@stellar/stellar-sdk";
import { getAddress, isAddress, bytesToHex } from "viem";

export const STELLAR_TESTNET_ID = 1201081091099711;
export const STELLAR_TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const BASE_TESTNET_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export type StellarBaseSepoliaDeployment = {
  schemaVersion: 1;
  corridor: "stellar-testnet-base-sepolia";
  addressProvenance: "predicted" | "deployment-record";
  stellar: { inputEscrow: string; outputSettler: string; axelarOracle: string };
  baseSepolia: { axelarOracle: `0x${string}` };
};
const mainnet = [
  "CA5GTK5U5LYGWIJSAG6LD724NUDFONHVEHYOHOH5KWCKCX5I442QYLUN",
  "CBNYANRIUUUTAZJSEA2FEYUHFPUNRRYPUP6URIZIG2PZXTWWYSXLL3SX",
  "CCIJYT5LJBNO5WHW5OJILTLQXSPC5CZWGCNT5B2MSXD2FDV6VIU7UMPT",
  "CAVJORXN3EOHH5GGHOK66YTPBUFNICWGSAO3UBUG6SS75VSMGWIEQX4V"
];
function keys(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== expected.sort().join()
  )
    throw new Error("Invalid Stellar testnet deployment fields");
}
export function parseStellarTestnetDeployment(text: string): StellarBaseSepoliaDeployment {
  const value: unknown = JSON.parse(text);
  keys(value, ["schemaVersion", "corridor", "addressProvenance", "stellar", "baseSepolia"]);
  if (
    value.schemaVersion !== 1 ||
    value.corridor !== "stellar-testnet-base-sepolia" ||
    !["predicted", "deployment-record"].includes(String(value.addressProvenance))
  )
    throw new Error("Unsupported Stellar testnet deployment schema/corridor/provenance");
  keys(value.stellar, ["inputEscrow", "outputSettler", "axelarOracle"]);
  keys(value.baseSepolia, ["axelarOracle"]);
  for (const address of Object.values(value.stellar)) {
    if (
      typeof address !== "string" ||
      !StrKey.isValidContract(address) ||
      mainnet.includes(address) ||
      StrKey.decodeContract(address).every((byte) => byte === 0)
    )
      throw new Error("Stellar testnet requires nonzero C-contracts, not mainnet deployments");
  }
  const evm = value.baseSepolia.axelarOracle;
  if (
    typeof evm !== "string" ||
    !isAddress(evm) ||
    BigInt(evm) === 0n ||
    evm.toLowerCase() === "0xb7ea767b54af5dd8ad12df648a399f9075d93fee"
  )
    throw new Error("Invalid Base Sepolia application oracle");
  return {
    ...value,
    baseSepolia: { axelarOracle: getAddress(evm).toLowerCase() }
  } as StellarBaseSepoliaDeployment;
}
export function loadStellarTestnet(enabled?: string, text?: string) {
  if (enabled !== undefined && enabled !== "true" && enabled !== "false")
    throw new Error("PUBLIC_STELLAR_TESTNET_ENABLED must be true or false");
  const deployment = text !== undefined ? parseStellarTestnetDeployment(text) : undefined;
  if (enabled === "true" && deployment?.addressProvenance !== "deployment-record")
    throw new Error("Stellar testnet enabled without complete deployment-record configuration");
  return { enabled: enabled === "true", deployment };
}
export function stellarContractHex(address: string) {
  return bytesToHex(StrKey.decodeContract(address));
}
export function isTestnetCorridor(a: number | bigint, b: number | bigint) {
  return (
    (Number(a) === STELLAR_TESTNET_ID && Number(b) === 84532) ||
    (Number(a) === 84532 && Number(b) === STELLAR_TESTNET_ID)
  );
}
