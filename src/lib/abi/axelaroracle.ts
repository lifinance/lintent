// Fragments of lifi-oif AxelarOracle (out/AxelarOracle.sol/AxelarOracle.json).
export const AXELAR_ORACLE_ABI = [
  {
    type: "function",
    name: "isProven",
    inputs: [
      { name: "remoteChainId", type: "uint256", internalType: "uint256" },
      { name: "remoteOracle", type: "bytes32", internalType: "bytes32" },
      { name: "application", type: "bytes32", internalType: "bytes32" },
      { name: "dataHash", type: "bytes32", internalType: "bytes32" }
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "chainIdMap",
    inputs: [{ name: "key", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "reverseChainIdMap",
    inputs: [{ name: "chainId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "submit",
    inputs: [
      { name: "destinationChainId", type: "uint256", internalType: "uint256" },
      { name: "recipientOracle", type: "string", internalType: "string" },
      { name: "source", type: "address", internalType: "address" },
      { name: "payloads", type: "bytes[]", internalType: "bytes[]" },
      { name: "destinationConfig", type: "bytes32", internalType: "bytes32" },
      { name: "deliveryMode", type: "uint8", internalType: "enum AxelarOracle.DeliveryMode" }
    ],
    outputs: [],
    stateMutability: "payable"
  }
] as const;
