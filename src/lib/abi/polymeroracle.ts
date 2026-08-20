export const POLYMER_ORACLE_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "crossL2Prover",
        type: "address",
        internalType: "address"
      }
    ],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "efficientRequireProven",
    inputs: [
      {
        name: "proofSeries",
        type: "bytes",
        internalType: "bytes"
      }
    ],
    outputs: [],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "isProven",
    inputs: [
      {
        name: "remoteChainId",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "remoteOracle",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "application",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "dataHash",
        type: "bytes32",
        internalType: "bytes32"
      }
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "receiveMessage",
    inputs: [
      {
        name: "proofs",
        type: "bytes[]",
        internalType: "bytes[]"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "receiveMessage",
    inputs: [
      {
        name: "proof",
        type: "bytes",
        internalType: "bytes"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  // A Solana proof MUST go here, not to receiveMessage: the two decode
  // different things. receiveMessage calls ICrossL2ProverV2.validateEvent,
  // which parses an EVM event log; this one calls validateSolLogs. Feeding a
  // Solana proof to the EVM entry point reverts with no reason string.
  //
  // They also key the attestation differently. The EVM path stores under the
  // local oracle's own identifier; this one stores under Polymer's
  // `returnedProgramId` — which is why a Solana output must carry the Polymer
  // PROGRAM ID in `output.oracle` for isProven to find it.
  {
    type: "function",
    name: "receiveSolanaMessage",
    inputs: [
      {
        name: "proof",
        type: "bytes",
        internalType: "bytes"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "receiveSolanaMessage",
    inputs: [
      {
        name: "proofs",
        type: "bytes[]",
        internalType: "bytes[]"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "event",
    name: "OutputProven",
    inputs: [
      {
        name: "chainid",
        type: "uint256",
        indexed: false,
        internalType: "uint256"
      },
      {
        name: "remoteIdentifier",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32"
      },
      {
        name: "application",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32"
      },
      {
        name: "payloadHash",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32"
      }
    ],
    anonymous: false
  },
  {
    type: "error",
    name: "CallOutOfRange",
    inputs: []
  },
  {
    type: "error",
    name: "ContextOutOfRange",
    inputs: []
  },
  {
    type: "error",
    name: "NotDivisible",
    inputs: [
      {
        name: "value",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "divisor",
        type: "uint256",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "NotProven",
    inputs: []
  },
  {
    type: "error",
    name: "WrongEventSignature",
    inputs: []
  }
] as const;
