import { parseAbi } from "viem";

export const VOW_ORACLE_ABI = parseAbi([
  "function receiveMessage(bytes proof)",
  "function directory() view returns (address)",
  "function isProven(uint256 remoteChainId, bytes32 remoteOracle, bytes32 application, bytes32 dataHash) view returns (bool)"
]);
export const WITNESS_DIRECTORY_ABI = parseAbi([
  "function getSigner(uint256 index) view returns (address)"
]);
