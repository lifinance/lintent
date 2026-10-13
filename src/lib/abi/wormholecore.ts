export const WORMHOLE_CORE_ABI = [
  {
    type: "function",
    name: "chainId",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "messageFee",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view"
  },
  {
    type: "event",
    name: "LogMessagePublished",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "sequence", type: "uint64", indexed: false },
      { name: "nonce", type: "uint32", indexed: false },
      { name: "payload", type: "bytes", indexed: false },
      { name: "consistencyLevel", type: "uint8", indexed: false }
    ],
    anonymous: false
  }
] as const;
