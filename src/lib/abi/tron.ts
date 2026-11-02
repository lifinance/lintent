// Deployed-generation ABIs for the canonical Tron contracts.
// Sources: lifi-oif Foundry artifacts, function-set-verified against the
// on-chain ABIs (TronGrid wallet/getcontract) for:
//   InputSettlerEscrowLIFITron  TRV3PsTLRiWpY6sWi5UAvB7Tacb2FLtCNq / 0xaa2e58aa1a4107dc8cc7ef41b97be90b25b5b842
//   OutputSettlerSimple         TLwJhhq7fExHWdJQfMnsSY7VcreipmhLRm / 0x784d4f7b6e99b22d923ec99edbe2e11b38ceac93
//   PolymerOracleMapped         TPXQkHcGwEdH4Ss8kT4cDxgXt3L4n4zSHJ / 0x94b0c01e26aff5a6a0fd767afe0e3ca0f8b34e3d
// The EVM chains use the older generation until the Aug 6 cutover — do not merge these with the EVM ABI files.

export const TRON_INPUT_SETTLER_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "initialOwner",
        type: "address",
        internalType: "address"
      }
    ],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "USDT",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "applyGovernanceFee",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "cancelOwnershipHandover",
    inputs: [],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "completeOwnershipHandover",
    inputs: [
      {
        name: "pendingOwner",
        type: "address",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "eip712Domain",
    inputs: [],
    outputs: [
      {
        name: "fields",
        type: "bytes1",
        internalType: "bytes1"
      },
      {
        name: "name",
        type: "string",
        internalType: "string"
      },
      {
        name: "version",
        type: "string",
        internalType: "string"
      },
      {
        name: "chainId",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "verifyingContract",
        type: "address",
        internalType: "address"
      },
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "extensions",
        type: "uint256[]",
        internalType: "uint256[]"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "finalise",
    inputs: [
      {
        name: "order",
        type: "tuple",
        internalType: "struct StandardOrder",
        components: [
          {
            name: "user",
            type: "address",
            internalType: "address"
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "originChainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "expires",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "fillDeadline",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "inputOracle",
            type: "address",
            internalType: "address"
          },
          {
            name: "inputs",
            type: "uint256[2][]",
            internalType: "uint256[2][]"
          },
          {
            name: "outputs",
            type: "tuple[]",
            internalType: "struct MandateOutput[]",
            components: [
              {
                name: "oracle",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "settler",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "chainId",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "token",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "recipient",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "callbackData",
                type: "bytes",
                internalType: "bytes"
              },
              {
                name: "context",
                type: "bytes",
                internalType: "bytes"
              }
            ]
          }
        ]
      },
      {
        name: "solveParams",
        type: "tuple[]",
        internalType: "struct InputSettlerBase.SolveParams[]",
        components: [
          {
            name: "timestamp",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "solver",
            type: "bytes32",
            internalType: "bytes32"
          }
        ]
      },
      {
        name: "destination",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "call",
        type: "bytes",
        internalType: "bytes"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "finaliseWithSignature",
    inputs: [
      {
        name: "order",
        type: "tuple",
        internalType: "struct StandardOrder",
        components: [
          {
            name: "user",
            type: "address",
            internalType: "address"
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "originChainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "expires",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "fillDeadline",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "inputOracle",
            type: "address",
            internalType: "address"
          },
          {
            name: "inputs",
            type: "uint256[2][]",
            internalType: "uint256[2][]"
          },
          {
            name: "outputs",
            type: "tuple[]",
            internalType: "struct MandateOutput[]",
            components: [
              {
                name: "oracle",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "settler",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "chainId",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "token",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "recipient",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "callbackData",
                type: "bytes",
                internalType: "bytes"
              },
              {
                name: "context",
                type: "bytes",
                internalType: "bytes"
              }
            ]
          }
        ]
      },
      {
        name: "solveParams",
        type: "tuple[]",
        internalType: "struct InputSettlerBase.SolveParams[]",
        components: [
          {
            name: "timestamp",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "solver",
            type: "bytes32",
            internalType: "bytes32"
          }
        ]
      },
      {
        name: "destination",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "call",
        type: "bytes",
        internalType: "bytes"
      },
      {
        name: "orderOwnerSignature",
        type: "bytes",
        internalType: "bytes"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "governanceFee",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint64",
        internalType: "uint64"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "nextGovernanceFee",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint64",
        internalType: "uint64"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "nextGovernanceFeeTime",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint64",
        internalType: "uint64"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "open",
    inputs: [
      {
        name: "order",
        type: "tuple",
        internalType: "struct StandardOrder",
        components: [
          {
            name: "user",
            type: "address",
            internalType: "address"
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "originChainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "expires",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "fillDeadline",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "inputOracle",
            type: "address",
            internalType: "address"
          },
          {
            name: "inputs",
            type: "uint256[2][]",
            internalType: "uint256[2][]"
          },
          {
            name: "outputs",
            type: "tuple[]",
            internalType: "struct MandateOutput[]",
            components: [
              {
                name: "oracle",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "settler",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "chainId",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "token",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "recipient",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "callbackData",
                type: "bytes",
                internalType: "bytes"
              },
              {
                name: "context",
                type: "bytes",
                internalType: "bytes"
              }
            ]
          }
        ]
      }
    ],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "openFor",
    inputs: [
      {
        name: "order",
        type: "tuple",
        internalType: "struct StandardOrder",
        components: [
          {
            name: "user",
            type: "address",
            internalType: "address"
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "originChainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "expires",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "fillDeadline",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "inputOracle",
            type: "address",
            internalType: "address"
          },
          {
            name: "inputs",
            type: "uint256[2][]",
            internalType: "uint256[2][]"
          },
          {
            name: "outputs",
            type: "tuple[]",
            internalType: "struct MandateOutput[]",
            components: [
              {
                name: "oracle",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "settler",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "chainId",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "token",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "recipient",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "callbackData",
                type: "bytes",
                internalType: "bytes"
              },
              {
                name: "context",
                type: "bytes",
                internalType: "bytes"
              }
            ]
          }
        ]
      },
      {
        name: "sponsor",
        type: "address",
        internalType: "address"
      },
      {
        name: "signature",
        type: "bytes",
        internalType: "bytes"
      }
    ],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "openForAndFinalise",
    inputs: [
      {
        name: "order",
        type: "tuple",
        internalType: "struct StandardOrder",
        components: [
          {
            name: "user",
            type: "address",
            internalType: "address"
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "originChainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "expires",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "fillDeadline",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "inputOracle",
            type: "address",
            internalType: "address"
          },
          {
            name: "inputs",
            type: "uint256[2][]",
            internalType: "uint256[2][]"
          },
          {
            name: "outputs",
            type: "tuple[]",
            internalType: "struct MandateOutput[]",
            components: [
              {
                name: "oracle",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "settler",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "chainId",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "token",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "recipient",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "callbackData",
                type: "bytes",
                internalType: "bytes"
              },
              {
                name: "context",
                type: "bytes",
                internalType: "bytes"
              }
            ]
          }
        ]
      },
      {
        name: "sponsor",
        type: "address",
        internalType: "address"
      },
      {
        name: "signature",
        type: "bytes",
        internalType: "bytes"
      },
      {
        name: "destination",
        type: "address",
        internalType: "address"
      },
      {
        name: "call",
        type: "bytes",
        internalType: "bytes"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "orderIdentifier",
    inputs: [
      {
        name: "order",
        type: "tuple",
        internalType: "struct StandardOrder",
        components: [
          {
            name: "user",
            type: "address",
            internalType: "address"
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "originChainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "expires",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "fillDeadline",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "inputOracle",
            type: "address",
            internalType: "address"
          },
          {
            name: "inputs",
            type: "uint256[2][]",
            internalType: "uint256[2][]"
          },
          {
            name: "outputs",
            type: "tuple[]",
            internalType: "struct MandateOutput[]",
            components: [
              {
                name: "oracle",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "settler",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "chainId",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "token",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "recipient",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "callbackData",
                type: "bytes",
                internalType: "bytes"
              },
              {
                name: "context",
                type: "bytes",
                internalType: "bytes"
              }
            ]
          }
        ]
      }
    ],
    outputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "orderStatus",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        internalType: "bytes32"
      }
    ],
    outputs: [
      {
        name: "",
        type: "uint8",
        internalType: "enum InputSettlerEscrow.OrderStatus"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [
      {
        name: "result",
        type: "address",
        internalType: "address"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "ownershipHandoverExpiresAt",
    inputs: [
      {
        name: "pendingOwner",
        type: "address",
        internalType: "address"
      }
    ],
    outputs: [
      {
        name: "result",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "purchaseOrder",
    inputs: [
      {
        name: "orderPurchase",
        type: "tuple",
        internalType: "struct OrderPurchase",
        components: [
          {
            name: "orderId",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "destination",
            type: "address",
            internalType: "address"
          },
          {
            name: "callData",
            type: "bytes",
            internalType: "bytes"
          },
          {
            name: "discount",
            type: "uint64",
            internalType: "uint64"
          },
          {
            name: "timeToBuy",
            type: "uint32",
            internalType: "uint32"
          }
        ]
      },
      {
        name: "order",
        type: "tuple",
        internalType: "struct StandardOrder",
        components: [
          {
            name: "user",
            type: "address",
            internalType: "address"
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "originChainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "expires",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "fillDeadline",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "inputOracle",
            type: "address",
            internalType: "address"
          },
          {
            name: "inputs",
            type: "uint256[2][]",
            internalType: "uint256[2][]"
          },
          {
            name: "outputs",
            type: "tuple[]",
            internalType: "struct MandateOutput[]",
            components: [
              {
                name: "oracle",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "settler",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "chainId",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "token",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "recipient",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "callbackData",
                type: "bytes",
                internalType: "bytes"
              },
              {
                name: "context",
                type: "bytes",
                internalType: "bytes"
              }
            ]
          }
        ]
      },
      {
        name: "orderSolvedByIdentifier",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "purchaser",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "expiryTimestamp",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "solverSignature",
        type: "bytes",
        internalType: "bytes"
      }
    ],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "purchasedOrders",
    inputs: [
      {
        name: "solver",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "orderId",
        type: "bytes32",
        internalType: "bytes32"
      }
    ],
    outputs: [
      {
        name: "lastOrderTimestamp",
        type: "uint32",
        internalType: "uint32"
      },
      {
        name: "purchaser",
        type: "bytes32",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "refund",
    inputs: [
      {
        name: "order",
        type: "tuple",
        internalType: "struct StandardOrder",
        components: [
          {
            name: "user",
            type: "address",
            internalType: "address"
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "originChainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "expires",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "fillDeadline",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "inputOracle",
            type: "address",
            internalType: "address"
          },
          {
            name: "inputs",
            type: "uint256[2][]",
            internalType: "uint256[2][]"
          },
          {
            name: "outputs",
            type: "tuple[]",
            internalType: "struct MandateOutput[]",
            components: [
              {
                name: "oracle",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "settler",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "chainId",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "token",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "recipient",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "callbackData",
                type: "bytes",
                internalType: "bytes"
              },
              {
                name: "context",
                type: "bytes",
                internalType: "bytes"
              }
            ]
          }
        ]
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "refundOnNonFill",
    inputs: [
      {
        name: "order",
        type: "tuple",
        internalType: "struct StandardOrder",
        components: [
          {
            name: "user",
            type: "address",
            internalType: "address"
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "originChainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "expires",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "fillDeadline",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "inputOracle",
            type: "address",
            internalType: "address"
          },
          {
            name: "inputs",
            type: "uint256[2][]",
            internalType: "uint256[2][]"
          },
          {
            name: "outputs",
            type: "tuple[]",
            internalType: "struct MandateOutput[]",
            components: [
              {
                name: "oracle",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "settler",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "chainId",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "token",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "recipient",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "callbackData",
                type: "bytes",
                internalType: "bytes"
              },
              {
                name: "context",
                type: "bytes",
                internalType: "bytes"
              }
            ]
          }
        ]
      },
      {
        name: "outputIndex",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "renounceOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "requestOwnershipHandover",
    inputs: [],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "setGovernanceFee",
    inputs: [
      {
        name: "_nextGovernanceFee",
        type: "uint64",
        internalType: "uint64"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [
      {
        name: "newOwner",
        type: "address",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "event",
    name: "EIP712DomainChanged",
    inputs: [],
    anonymous: false
  },
  {
    type: "event",
    name: "Finalised",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32"
      },
      {
        name: "solver",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32"
      },
      {
        name: "destination",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "GovernanceFeeChanged",
    inputs: [
      {
        name: "oldGovernanceFee",
        type: "uint64",
        indexed: false,
        internalType: "uint64"
      },
      {
        name: "newGovernanceFee",
        type: "uint64",
        indexed: false,
        internalType: "uint64"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "NextGovernanceFee",
    inputs: [
      {
        name: "nextGovernanceFee",
        type: "uint64",
        indexed: false,
        internalType: "uint64"
      },
      {
        name: "nextGovernanceFeeTime",
        type: "uint64",
        indexed: false,
        internalType: "uint64"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "Open",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32"
      },
      {
        name: "order",
        type: "tuple",
        indexed: false,
        internalType: "struct StandardOrder",
        components: [
          {
            name: "user",
            type: "address",
            internalType: "address"
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "originChainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "expires",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "fillDeadline",
            type: "uint32",
            internalType: "uint32"
          },
          {
            name: "inputOracle",
            type: "address",
            internalType: "address"
          },
          {
            name: "inputs",
            type: "uint256[2][]",
            internalType: "uint256[2][]"
          },
          {
            name: "outputs",
            type: "tuple[]",
            internalType: "struct MandateOutput[]",
            components: [
              {
                name: "oracle",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "settler",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "chainId",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "token",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
              },
              {
                name: "recipient",
                type: "bytes32",
                internalType: "bytes32"
              },
              {
                name: "callbackData",
                type: "bytes",
                internalType: "bytes"
              },
              {
                name: "context",
                type: "bytes",
                internalType: "bytes"
              }
            ]
          }
        ]
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "Open",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "OrderPurchased",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32"
      },
      {
        name: "solver",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32"
      },
      {
        name: "purchaser",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "OwnershipHandoverCanceled",
    inputs: [
      {
        name: "pendingOwner",
        type: "address",
        indexed: true,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "OwnershipHandoverRequested",
    inputs: [
      {
        name: "pendingOwner",
        type: "address",
        indexed: true,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      {
        name: "oldOwner",
        type: "address",
        indexed: true,
        internalType: "address"
      },
      {
        name: "newOwner",
        type: "address",
        indexed: true,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32"
      }
    ],
    anonymous: false
  },
  {
    type: "error",
    name: "AlreadyInitialized",
    inputs: []
  },
  {
    type: "error",
    name: "AlreadyPurchased",
    inputs: []
  },
  {
    type: "error",
    name: "CallOutOfRange",
    inputs: []
  },
  {
    type: "error",
    name: "CodeSize0",
    inputs: []
  },
  {
    type: "error",
    name: "ContextOutOfRange",
    inputs: []
  },
  {
    type: "error",
    name: "Expired",
    inputs: []
  },
  {
    type: "error",
    name: "FailedCall",
    inputs: []
  },
  {
    type: "error",
    name: "FillDeadlineAfterExpiry",
    inputs: [
      {
        name: "fillDeadline",
        type: "uint32",
        internalType: "uint32"
      },
      {
        name: "expires",
        type: "uint32",
        internalType: "uint32"
      }
    ]
  },
  {
    type: "error",
    name: "FilledTooLate",
    inputs: [
      {
        name: "expected",
        type: "uint32",
        internalType: "uint32"
      },
      {
        name: "actual",
        type: "uint32",
        internalType: "uint32"
      }
    ]
  },
  {
    type: "error",
    name: "GovernanceFeeChangeNotReady",
    inputs: []
  },
  {
    type: "error",
    name: "GovernanceFeeTooHigh",
    inputs: []
  },
  {
    type: "error",
    name: "HasDirtyBits",
    inputs: []
  },
  {
    type: "error",
    name: "InsufficientBalance",
    inputs: [
      {
        name: "balance",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "needed",
        type: "uint256",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "InvalidBalanceDelta",
    inputs: [
      {
        name: "expectedBalance",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "actualBalance",
        type: "uint256",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "InvalidNativeValue",
    inputs: [
      {
        name: "expected",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "actual",
        type: "uint256",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "InvalidOrderStatus",
    inputs: []
  },
  {
    type: "error",
    name: "InvalidPurchaser",
    inputs: []
  },
  {
    type: "error",
    name: "InvalidShortString",
    inputs: []
  },
  {
    type: "error",
    name: "InvalidSigner",
    inputs: []
  },
  {
    type: "error",
    name: "InvalidTimestampLength",
    inputs: []
  },
  {
    type: "error",
    name: "NativeTokenNotSupported",
    inputs: []
  },
  {
    type: "error",
    name: "NewOwnerIsZeroAddress",
    inputs: []
  },
  {
    type: "error",
    name: "NoDestination",
    inputs: []
  },
  {
    type: "error",
    name: "NoHandoverRequest",
    inputs: []
  },
  {
    type: "error",
    name: "NotOrderOwner",
    inputs: []
  },
  {
    type: "error",
    name: "OrderIdMismatch",
    inputs: [
      {
        name: "provided",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "computed",
        type: "bytes32",
        internalType: "bytes32"
      }
    ]
  },
  {
    type: "error",
    name: "OutputIndexOutOfBounds",
    inputs: [
      {
        name: "index",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "length",
        type: "uint256",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "ReentrancyDetected",
    inputs: []
  },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "SafeTRC20FailedOperation",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "SignatureAndInputsNotEqual",
    inputs: []
  },
  {
    type: "error",
    name: "SignatureNotSupported",
    inputs: [
      {
        name: "",
        type: "bytes1",
        internalType: "bytes1"
      }
    ]
  },
  {
    type: "error",
    name: "StringTooLong",
    inputs: [
      {
        name: "str",
        type: "string",
        internalType: "string"
      }
    ]
  },
  {
    type: "error",
    name: "TimestampNotPassed",
    inputs: []
  },
  {
    type: "error",
    name: "TimestampPassed",
    inputs: []
  },
  {
    type: "error",
    name: "Unauthorized",
    inputs: []
  },
  {
    type: "error",
    name: "UserIsZero",
    inputs: []
  },
  {
    type: "error",
    name: "WrongChain",
    inputs: [
      {
        name: "expected",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "actual",
        type: "uint256",
        internalType: "uint256"
      }
    ]
  }
] as const;

export const TRON_OUTPUT_SETTLER_ABI = [
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
    name: "emitNotFilled",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "output",
        type: "tuple",
        internalType: "struct MandateOutput",
        components: [
          {
            name: "oracle",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "settler",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "chainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "token",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "amount",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "recipient",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "callbackData",
            type: "bytes",
            internalType: "bytes"
          },
          {
            name: "context",
            type: "bytes",
            internalType: "bytes"
          }
        ]
      },
      {
        name: "fillDeadline",
        type: "uint32",
        internalType: "uint32"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "fill",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "output",
        type: "tuple",
        internalType: "struct MandateOutput",
        components: [
          {
            name: "oracle",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "settler",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "chainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "token",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "amount",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "recipient",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "callbackData",
            type: "bytes",
            internalType: "bytes"
          },
          {
            name: "context",
            type: "bytes",
            internalType: "bytes"
          }
        ]
      },
      {
        name: "fillDeadline",
        type: "uint48",
        internalType: "uint48"
      },
      {
        name: "fillerData",
        type: "bytes",
        internalType: "bytes"
      }
    ],
    outputs: [
      {
        name: "fillRecordHash",
        type: "bytes32",
        internalType: "bytes32"
      }
    ],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "fillOrderOutputs",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "outputs",
        type: "tuple[]",
        internalType: "struct MandateOutput[]",
        components: [
          {
            name: "oracle",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "settler",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "chainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "token",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "amount",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "recipient",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "callbackData",
            type: "bytes",
            internalType: "bytes"
          },
          {
            name: "context",
            type: "bytes",
            internalType: "bytes"
          }
        ]
      },
      {
        name: "fillDeadline",
        type: "uint48",
        internalType: "uint48"
      },
      {
        name: "fillerData",
        type: "bytes",
        internalType: "bytes"
      }
    ],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "getFillRecord",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "output",
        type: "tuple",
        internalType: "struct MandateOutput",
        components: [
          {
            name: "oracle",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "settler",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "chainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "token",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "amount",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "recipient",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "callbackData",
            type: "bytes",
            internalType: "bytes"
          },
          {
            name: "context",
            type: "bytes",
            internalType: "bytes"
          }
        ]
      }
    ],
    outputs: [
      {
        name: "payloadHash",
        type: "bytes32",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "getFillRecord",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "outputHash",
        type: "bytes32",
        internalType: "bytes32"
      }
    ],
    outputs: [
      {
        name: "payloadHash",
        type: "bytes32",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "hasAttested",
    inputs: [
      {
        name: "payloads",
        type: "bytes[]",
        internalType: "bytes[]"
      }
    ],
    outputs: [
      {
        name: "accumulator",
        type: "bool",
        internalType: "bool"
      }
    ],
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
    name: "setAttestation",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "solver",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "timestamp",
        type: "uint32",
        internalType: "uint32"
      },
      {
        name: "output",
        type: "tuple",
        internalType: "struct MandateOutput",
        components: [
          {
            name: "oracle",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "settler",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "chainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "token",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "amount",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "recipient",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "callbackData",
            type: "bytes",
            internalType: "bytes"
          },
          {
            name: "context",
            type: "bytes",
            internalType: "bytes"
          }
        ]
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "event",
    name: "OutputFilled",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32"
      },
      {
        name: "solver",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32"
      },
      {
        name: "timestamp",
        type: "uint32",
        indexed: false,
        internalType: "uint32"
      },
      {
        name: "output",
        type: "tuple",
        indexed: false,
        internalType: "struct MandateOutput",
        components: [
          {
            name: "oracle",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "settler",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "chainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "token",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "amount",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "recipient",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "callbackData",
            type: "bytes",
            internalType: "bytes"
          },
          {
            name: "context",
            type: "bytes",
            internalType: "bytes"
          }
        ]
      },
      {
        name: "finalAmount",
        type: "uint256",
        indexed: false,
        internalType: "uint256"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "OutputNotFilled",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32"
      },
      {
        name: "output",
        type: "tuple",
        indexed: false,
        internalType: "struct MandateOutput",
        components: [
          {
            name: "oracle",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "settler",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "chainId",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "token",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "amount",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "recipient",
            type: "bytes32",
            internalType: "bytes32"
          },
          {
            name: "callbackData",
            type: "bytes",
            internalType: "bytes"
          },
          {
            name: "context",
            type: "bytes",
            internalType: "bytes"
          }
        ]
      },
      {
        name: "fillDeadline",
        type: "uint32",
        indexed: false,
        internalType: "uint32"
      }
    ],
    anonymous: false
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
    name: "AlreadyFilled",
    inputs: []
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
    name: "ExclusiveTo",
    inputs: [
      {
        name: "solver",
        type: "bytes32",
        internalType: "bytes32"
      }
    ]
  },
  {
    type: "error",
    name: "FailedCall",
    inputs: []
  },
  {
    type: "error",
    name: "FillDeadline",
    inputs: []
  },
  {
    type: "error",
    name: "FillDeadlineNotPassed",
    inputs: []
  },
  {
    type: "error",
    name: "FillerDataTooShort",
    inputs: []
  },
  {
    type: "error",
    name: "HasDirtyBits",
    inputs: []
  },
  {
    type: "error",
    name: "InsufficientBalance",
    inputs: [
      {
        name: "balance",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "needed",
        type: "uint256",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "InvalidAttestation",
    inputs: [
      {
        name: "storedFillRecordHash",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "givenFillRecordHash",
        type: "bytes32",
        internalType: "bytes32"
      }
    ]
  },
  {
    type: "error",
    name: "InvalidContextDataLength",
    inputs: []
  },
  {
    type: "error",
    name: "InvalidPayloadMagic",
    inputs: [
      {
        name: "magic",
        type: "bytes4",
        internalType: "bytes4"
      }
    ]
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
    name: "NotImplemented",
    inputs: []
  },
  {
    type: "error",
    name: "NotProven",
    inputs: []
  },
  {
    type: "error",
    name: "PayloadTooSmall",
    inputs: []
  },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "WrongChain",
    inputs: [
      {
        name: "expected",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "actual",
        type: "uint256",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "WrongOutputOracle",
    inputs: [
      {
        name: "addressThis",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "expected",
        type: "bytes32",
        internalType: "bytes32"
      }
    ]
  },
  {
    type: "error",
    name: "WrongOutputSettler",
    inputs: [
      {
        name: "addressThis",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "expected",
        type: "bytes32",
        internalType: "bytes32"
      }
    ]
  },
  {
    type: "error",
    name: "ZeroValue",
    inputs: []
  }
] as const;

export const TRON_POLYMER_ORACLE_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "_owner",
        type: "address",
        internalType: "address"
      },
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
    name: "chainIdMap",
    inputs: [
      {
        name: "protocolChainidentifier",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        name: "chainId",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    stateMutability: "view"
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
    name: "owner",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address"
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
    name: "renounceOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "reverseChainIdMap",
    inputs: [
      {
        name: "chainId",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        name: "protocolChainidentifier",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "setChainMap",
    inputs: [
      {
        name: "protocolChainIdentifier",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "chainId",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [
      {
        name: "newOwner",
        type: "address",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "event",
    name: "ChainMapConfigured",
    inputs: [
      {
        name: "protocolChainIdentifier",
        type: "uint256",
        indexed: false,
        internalType: "uint256"
      },
      {
        name: "chainId",
        type: "uint256",
        indexed: false,
        internalType: "uint256"
      }
    ],
    anonymous: false
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
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      {
        name: "previousOwner",
        type: "address",
        indexed: true,
        internalType: "address"
      },
      {
        name: "newOwner",
        type: "address",
        indexed: true,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "error",
    name: "AlreadySet",
    inputs: []
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
    name: "InvalidSolanaMessage",
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
    name: "NotSolanaMessage",
    inputs: []
  },
  {
    type: "error",
    name: "OwnableInvalidOwner",
    inputs: [
      {
        name: "owner",
        type: "address",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "OwnableUnauthorizedAccount",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "WrongEventSignature",
    inputs: []
  },
  {
    type: "error",
    name: "WrongOutputOracle",
    inputs: [
      {
        name: "addressThis",
        type: "bytes32",
        internalType: "bytes32"
      },
      {
        name: "expected",
        type: "bytes32",
        internalType: "bytes32"
      }
    ]
  },
  {
    type: "error",
    name: "ZeroValue",
    inputs: []
  }
] as const;
