export const COIN_FILLER_ABI = [
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
	}
] as const;
