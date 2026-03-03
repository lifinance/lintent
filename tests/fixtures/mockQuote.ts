export const mockQuoteResponse = {
	quotes: [
		{
			order: null,
			eta: null,
			validUntil: Date.now() + 30_000,
			quoteId: null,
			metadata: { exclusiveFor: "0x0000000000000000000000000000000000000000" },
			preview: {
				inputs: [],
				outputs: [
					{
						receiver: "0x0000000000000000000000000000000000000000",
						asset: "0x0000000000000000000000000000000000000000",
						amount: "1000000"
					}
				]
			},
			provider: null,
			partialFill: false,
			failureHandling: "refund-automatic"
		}
	]
};
