const bigIntSum = (...nums: bigint[]) => nums.reduce((a, b) => a + b, 0n);

export class AssetSelection {
	goal: bigint;
	values: bigint[];
	weights?: bigint[];

	sortedValues: bigint[];

	static Sum(values: bigint[]) {
		return bigIntSum(...values);
	}

	static feasible(goal: bigint, values: bigint[]) {
		if (bigIntSum(...values) < goal)
			throw Error(`Values makes ${bigIntSum(...values)} cannot sum ${goal}`);
	}

	static zip(arr: bigint[]): [bigint, number][] {
		return arr.map((v, i) => [v, i]);
	}

	static unzip(arr: [bigint, number][]): bigint[] {
		arr.sort((a, b) => a[1] - b[1]);
		return arr.map((v) => v[0]);
	}

	static takeFromArray<T>(goal: bigint, values: [bigint, T][]) {
		let sum = 0n;
		for (let i = 0; i < values.length; ++i) {
			const value = values[i][0];
			const less = goal - sum;
			const diff = less < value ? less : value;
			sum += diff;
			values[i][0] = diff;
		}
	}

	constructor(opts: { goal: bigint; values: bigint[]; weights?: bigint[] }) {
		AssetSelection.feasible(opts.goal, opts.values);
		this.goal = opts.goal;
		this.values = opts.values;
		this.weights = opts.weights;

		this.sortedValues = this.values;
	}

	// --- Get sorted values as --- //

	asValues() {
		return this.sortedValues;
	}

	asIndices() {
		const zipped = AssetSelection.zip(this.sortedValues);
		return zipped.filter((v) => v[0] > 0);
	}

	// --- Sorting Methods --- //

	largest() {
		const values = AssetSelection.zip(this.values);
		values.sort((a, b) => Number(b[0] - a[0]));

		AssetSelection.takeFromArray(this.goal, values);

		this.sortedValues = AssetSelection.unzip(values);
		return this;
	}

	smallest() {
		const values = AssetSelection.zip(this.values);
		values.sort((a, b) => Number(a[0] - b[0]));

		AssetSelection.takeFromArray(this.goal, values);

		this.sortedValues = AssetSelection.unzip(values);
		return this;
	}
}
