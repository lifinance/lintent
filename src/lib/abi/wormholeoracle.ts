// Callable proof/publication subset of the current WormholeOracle deployment.
export const WORMHOLE_ORACLE_ABI = [
  {
    type: "function",
    name: "WORMHOLE",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "chainIdMap",
    inputs: [{ name: "protocolChainIdentifier", type: "uint256" }],
    outputs: [{ name: "chainId", type: "uint256" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "reverseChainIdMap",
    inputs: [{ name: "chainId", type: "uint256" }],
    outputs: [{ name: "protocolChainIdentifier", type: "uint256" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "submit",
    inputs: [
      { name: "source", type: "address" },
      { name: "payloads", type: "bytes[]" }
    ],
    outputs: [{ name: "refund", type: "uint256" }],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "receiveMessage",
    inputs: [{ name: "rawMessage", type: "bytes" }],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "isProven",
    inputs: [
      { name: "remoteChainId", type: "uint256" },
      { name: "remoteOracle", type: "bytes32" },
      { name: "application", type: "bytes32" },
      { name: "dataHash", type: "bytes32" }
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "parseAndVerifyVM",
    inputs: [{ name: "encodedVM", type: "bytes" }],
    outputs: [
      { name: "emitterChainId", type: "uint16" },
      { name: "emitterAddress", type: "bytes32" },
      { name: "payload", type: "bytes" }
    ],
    stateMutability: "view"
  },
  { type: "error", name: "NotAllPayloadsValid", inputs: [] },
  { type: "error", name: "RefundFailed", inputs: [] },
  { type: "error", name: "ZeroValue", inputs: [] },
  // submit bubbles these failures from OutputSettlerBase.hasAttested.
  { type: "error", name: "PayloadTooSmall", inputs: [] },
  {
    type: "error",
    name: "InvalidPayloadMagic",
    inputs: [{ name: "magic", type: "bytes4" }]
  },
  {
    type: "error",
    name: "TooLargePayload",
    inputs: [{ name: "size", type: "uint256" }]
  },
  {
    type: "error",
    name: "TooManyPayloads",
    inputs: [{ name: "size", type: "uint256" }]
  },
  { type: "error", name: "InvalidSignatory", inputs: [] },
  { type: "error", name: "SignatureIndicesNotAscending", inputs: [] },
  { type: "error", name: "GuardianIndexOutOfBounds", inputs: [] },
  { type: "error", name: "VMVersionIncompatible", inputs: [] },
  { type: "error", name: "TooManyGuardians", inputs: [] },
  { type: "error", name: "VMSignatureInvalid", inputs: [] },
  { type: "error", name: "InvalidGuardianSet", inputs: [] },
  { type: "error", name: "GuardianSetExpired", inputs: [] },
  { type: "error", name: "NoQuorum", inputs: [] }
] as const;
