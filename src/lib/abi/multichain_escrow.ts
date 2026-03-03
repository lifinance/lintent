export const MULTICHAIN_SETTLER_ESCROW_ABI = [
	{
		type: "constructor",
		inputs: [],
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
				internalType: "struct MultichainOrderComponent",
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
						name: "chainIdField",
						type: "uint256",
						internalType: "uint256"
					},
					{
						name: "chainIndex",
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
					},
					{
						name: "additionalChains",
						type: "bytes32[]",
						internalType: "bytes32[]"
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
				internalType: "struct MultichainOrderComponent",
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
						name: "chainIdField",
						type: "uint256",
						internalType: "uint256"
					},
					{
						name: "chainIndex",
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
					},
					{
						name: "additionalChains",
						type: "bytes32[]",
						internalType: "bytes32[]"
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
		name: "open",
		inputs: [
			{
				name: "order",
				type: "tuple",
				internalType: "struct MultichainOrderComponent",
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
						name: "chainIdField",
						type: "uint256",
						internalType: "uint256"
					},
					{
						name: "chainIndex",
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
					},
					{
						name: "additionalChains",
						type: "bytes32[]",
						internalType: "bytes32[]"
					}
				]
			}
		],
		outputs: [],
		stateMutability: "nonpayable"
	},
	{
		type: "function",
		name: "openFor",
		inputs: [
			{
				name: "order",
				type: "tuple",
				internalType: "struct MultichainOrderComponent",
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
						name: "chainIdField",
						type: "uint256",
						internalType: "uint256"
					},
					{
						name: "chainIndex",
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
					},
					{
						name: "additionalChains",
						type: "bytes32[]",
						internalType: "bytes32[]"
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
		stateMutability: "nonpayable"
	},
	{
		type: "function",
		name: "orderIdentifier",
		inputs: [
			{
				name: "order",
				type: "tuple",
				internalType: "struct MultichainOrderComponent",
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
						name: "chainIdField",
						type: "uint256",
						internalType: "uint256"
					},
					{
						name: "chainIndex",
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
					},
					{
						name: "additionalChains",
						type: "bytes32[]",
						internalType: "bytes32[]"
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
				internalType: "enum InputSettlerMultichainEscrow.OrderStatus"
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
				internalType: "struct MultichainOrderComponent",
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
						name: "chainIdField",
						type: "uint256",
						internalType: "uint256"
					},
					{
						name: "chainIndex",
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
					},
					{
						name: "additionalChains",
						type: "bytes32[]",
						internalType: "bytes32[]"
					}
				]
			}
		],
		outputs: [],
		stateMutability: "nonpayable"
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
				type: "bytes",
				indexed: false,
				internalType: "bytes"
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
		name: "CallOutOfRange",
		inputs: []
	},
	{
		type: "error",
		name: "ChainIndexOutOfRange",
		inputs: [
			{
				name: "chainIndex",
				type: "uint256",
				internalType: "uint256"
			},
			{
				name: "numSegments",
				type: "uint256",
				internalType: "uint256"
			}
		]
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
		name: "HasDirtyBits",
		inputs: []
	},
	{
		type: "error",
		name: "InvalidOrderStatus",
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
		name: "NoDestination",
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
		name: "UnexpectedCaller",
		inputs: [
			{
				name: "expectedCaller",
				type: "bytes32",
				internalType: "bytes32"
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
	}
] as const;
