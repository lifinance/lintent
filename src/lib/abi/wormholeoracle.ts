export const WROMHOLE_ORACLE_ABI = [
	{
		type: "constructor",
		inputs: [
			{
				name: "_owner",
				type: "address",
				internalType: "address"
			},
			{
				name: "_wormhole",
				type: "address",
				internalType: "address"
			}
		],
		stateMutability: "payable"
	},
	{
		type: "function",
		name: "WORMHOLE",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "address",
				internalType: "contract IWormhole"
			}
		],
		stateMutability: "view"
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
		name: "chainId",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint16",
				internalType: "uint16"
			}
		],
		stateMutability: "view"
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
		name: "evmChainId",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint256",
				internalType: "uint256"
			}
		],
		stateMutability: "view"
	},
	{
		type: "function",
		name: "getBlockChainIdToChainIdentifier",
		inputs: [
			{
				name: "chainId",
				type: "uint256",
				internalType: "uint256"
			}
		],
		outputs: [
			{
				name: "messagingProtocolChainIdentifier",
				type: "uint16",
				internalType: "uint16"
			}
		],
		stateMutability: "view"
	},
	{
		type: "function",
		name: "getChainIdentifierToBlockChainId",
		inputs: [
			{
				name: "messagingProtocolChainIdentifier",
				type: "uint16",
				internalType: "uint16"
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
		name: "getCurrentGuardianSetIndex",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint32",
				internalType: "uint32"
			}
		],
		stateMutability: "view"
	},
	{
		type: "function",
		name: "getGuardianSet",
		inputs: [
			{
				name: "index",
				type: "uint32",
				internalType: "uint32"
			}
		],
		outputs: [
			{
				name: "",
				type: "tuple",
				internalType: "struct Structs.GuardianSet",
				components: [
					{
						name: "keys",
						type: "address[]",
						internalType: "address[]"
					},
					{
						name: "expirationTime",
						type: "uint32",
						internalType: "uint32"
					}
				]
			}
		],
		stateMutability: "view"
	},
	{
		type: "function",
		name: "getGuardianSetExpiry",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint32",
				internalType: "uint32"
			}
		],
		stateMutability: "view"
	},
	{
		type: "function",
		name: "governanceActionIsConsumed",
		inputs: [
			{
				name: "hash",
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
		name: "governanceChainId",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint16",
				internalType: "uint16"
			}
		],
		stateMutability: "view"
	},
	{
		type: "function",
		name: "governanceContract",
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
		name: "isFork",
		inputs: [],
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
		name: "isInitialized",
		inputs: [
			{
				name: "impl",
				type: "address",
				internalType: "address"
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
		name: "messageFee",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint256",
				internalType: "uint256"
			}
		],
		stateMutability: "view"
	},
	{
		type: "function",
		name: "nextSequence",
		inputs: [
			{
				name: "emitter",
				type: "address",
				internalType: "address"
			}
		],
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
		name: "parseAndVerifyVM",
		inputs: [
			{
				name: "encodedVM",
				type: "bytes",
				internalType: "bytes"
			}
		],
		outputs: [
			{
				name: "emitterChainId",
				type: "uint16",
				internalType: "uint16"
			},
			{
				name: "emitterAddress",
				type: "bytes32",
				internalType: "bytes32"
			},
			{
				name: "payload",
				type: "bytes",
				internalType: "bytes"
			}
		],
		stateMutability: "view"
	},
	{
		type: "function",
		name: "parseVM",
		inputs: [
			{
				name: "encodedVM",
				type: "bytes",
				internalType: "bytes"
			}
		],
		outputs: [
			{
				name: "emitterChainId",
				type: "uint16",
				internalType: "uint16"
			},
			{
				name: "emitterAddress",
				type: "bytes32",
				internalType: "bytes32"
			},
			{
				name: "guardianSetIndex",
				type: "uint32",
				internalType: "uint32"
			},
			{
				name: "signatures",
				type: "bytes",
				internalType: "bytes"
			},
			{
				name: "bodyHash",
				type: "bytes32",
				internalType: "bytes32"
			},
			{
				name: "payload",
				type: "bytes",
				internalType: "bytes"
			}
		],
		stateMutability: "view"
	},
	{
		type: "function",
		name: "quorum",
		inputs: [
			{
				name: "numGuardians",
				type: "uint256",
				internalType: "uint256"
			}
		],
		outputs: [
			{
				name: "numSignaturesRequiredForQuorum",
				type: "uint256",
				internalType: "uint256"
			}
		],
		stateMutability: "pure"
	},
	{
		type: "function",
		name: "receiveMessage",
		inputs: [
			{
				name: "rawMessage",
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
		name: "setChainMap",
		inputs: [
			{
				name: "messagingProtocolChainIdentifier",
				type: "uint16",
				internalType: "uint16"
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
		name: "submit",
		inputs: [
			{
				name: "proofSource",
				type: "address",
				internalType: "address"
			},
			{
				name: "payloads",
				type: "bytes[]",
				internalType: "bytes[]"
			}
		],
		outputs: [
			{
				name: "refund",
				type: "uint256",
				internalType: "uint256"
			}
		],
		stateMutability: "payable"
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
		type: "function",
		name: "verifySignatures",
		inputs: [
			{
				name: "hash",
				type: "bytes32",
				internalType: "bytes32"
			},
			{
				name: "signatures",
				type: "bytes",
				internalType: "bytes"
			},
			{
				name: "guardianSet",
				type: "tuple",
				internalType: "struct Structs.GuardianSet",
				components: [
					{
						name: "keys",
						type: "address[]",
						internalType: "address[]"
					},
					{
						name: "expirationTime",
						type: "uint32",
						internalType: "uint32"
					}
				]
			}
		],
		outputs: [],
		stateMutability: "pure"
	},
	{
		type: "event",
		name: "MapMessagingProtocolIdentifierToChainId",
		inputs: [
			{
				name: "messagingProtocolIdentifier",
				type: "uint16",
				indexed: false,
				internalType: "uint16"
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
		type: "error",
		name: "AlreadyInitialized",
		inputs: []
	},
	{
		type: "error",
		name: "AlreadySet",
		inputs: []
	},
	{
		type: "error",
		name: "GuardianIndexOutOfBounds",
		inputs: []
	},
	{
		type: "error",
		name: "GuardianSetExpired",
		inputs: []
	},
	{
		type: "error",
		name: "InvalidGuardianSet",
		inputs: []
	},
	{
		type: "error",
		name: "InvalidSignatory",
		inputs: []
	},
	{
		type: "error",
		name: "NewOwnerIsZeroAddress",
		inputs: []
	},
	{
		type: "error",
		name: "NoHandoverRequest",
		inputs: []
	},
	{
		type: "error",
		name: "NoQuorum",
		inputs: []
	},
	{
		type: "error",
		name: "NotAllPayloadsValid",
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
		name: "SignatureIndicesNotAscending",
		inputs: []
	},
	{
		type: "error",
		name: "TooLargePayload",
		inputs: [
			{
				name: "size",
				type: "uint256",
				internalType: "uint256"
			}
		]
	},
	{
		type: "error",
		name: "TooManyGuardians",
		inputs: []
	},
	{
		type: "error",
		name: "TooManyPayloads",
		inputs: [
			{
				name: "size",
				type: "uint256",
				internalType: "uint256"
			}
		]
	},
	{
		type: "error",
		name: "Unauthorized",
		inputs: []
	},
	{
		type: "error",
		name: "VMSignatureInvalid",
		inputs: []
	},
	{
		type: "error",
		name: "VMVersionIncompatible",
		inputs: []
	},
	{
		type: "error",
		name: "WormholeStateAddressZero",
		inputs: []
	},
	{
		type: "error",
		name: "ZeroValue",
		inputs: []
	}
] as const;
