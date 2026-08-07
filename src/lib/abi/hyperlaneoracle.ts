/**
 * `HyperlaneOracle` (lifi-oif `src/integrations/oracles/hyperlane/HyperlaneOracle.sol`).
 *
 * Only the entry points this app uses are listed. `submit` and `quoteGasPayment` are
 * overloaded on-chain: a second variant takes an extra `IPostDispatchHook customHook`
 * before `source`. Both overloads are `address` in the ABI, so listing both would leave
 * viem to disambiguate purely on argument count — deliberately omitted, since the app
 * always wants the oracle's configured hook.
 */
export const HYPERLANE_ORACLE_ABI = [
  {
    type: "function",
    name: "submit",
    inputs: [
      { name: "destinationDomain", type: "uint32", internalType: "uint32" },
      { name: "recipientOracle", type: "address", internalType: "address" },
      { name: "gasLimit", type: "uint256", internalType: "uint256" },
      { name: "customMetadata", type: "bytes", internalType: "bytes" },
      { name: "source", type: "address", internalType: "address" },
      { name: "payloads", type: "bytes[]", internalType: "bytes[]" }
    ],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "quoteGasPayment",
    inputs: [
      { name: "destinationDomain", type: "uint32", internalType: "uint32" },
      { name: "recipientOracle", type: "address", internalType: "address" },
      { name: "gasLimit", type: "uint256", internalType: "uint256" },
      { name: "customMetadata", type: "bytes", internalType: "bytes" },
      { name: "source", type: "address", internalType: "address" },
      { name: "payloads", type: "bytes[]", internalType: "bytes[]" }
    ],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view"
  },
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
    name: "handle",
    inputs: [
      { name: "messageOrigin", type: "uint32", internalType: "uint32" },
      { name: "messageSender", type: "bytes32", internalType: "bytes32" },
      { name: "message", type: "bytes", internalType: "bytes" }
    ],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "event",
    name: "OutputProven",
    inputs: [
      { name: "chainid", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "remoteIdentifier", type: "bytes32", indexed: false, internalType: "bytes32" },
      { name: "application", type: "bytes32", indexed: false, internalType: "bytes32" },
      { name: "payloadHash", type: "bytes32", indexed: false, internalType: "bytes32" }
    ],
    anonymous: false
  },
  {
    type: "error",
    name: "NotAllPayloadsValid",
    inputs: []
  }
] as const;
