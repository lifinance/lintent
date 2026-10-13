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
    name: "route",
    inputs: [{ name: "name", type: "string", internalType: "string" }],
    outputs: [
      {
        name: "r",
        type: "tuple",
        internalType: "struct AxelarOracle.Route",
        components: [
          { name: "chainId", type: "uint256", internalType: "uint256" },
          { name: "kind", type: "uint8", internalType: "enum OracleAddress.Kind" }
        ]
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "submit",
    inputs: [
      { name: "destinationChain", type: "string", internalType: "string" },
      { name: "recipientOracle", type: "bytes32", internalType: "bytes32" },
      { name: "source", type: "address", internalType: "address" },
      { name: "payloads", type: "bytes[]", internalType: "bytes[]" },
      { name: "destinationConfig", type: "bytes32", internalType: "bytes32" },
      { name: "deliveryMode", type: "uint8", internalType: "enum AxelarOracle.DeliveryMode" }
    ],
    outputs: [],
    stateMutability: "payable"
  }
] as const;
