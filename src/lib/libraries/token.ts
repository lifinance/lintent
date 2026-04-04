import { maxUint256 } from "viem";
import { COMPACT_ABI } from "../abi/compact";
import { ERC20_ABI } from "../abi/erc20";
import { ADDRESS_ZERO, clients, COMPACT } from "../config";
import { Connection, PublicKey } from "@solana/web3.js";
import { ResetPeriod, toId } from "@lifi/intent";

export async function getBalance(
	user: `0x${string}` | undefined,
	asset: `0x${string}`,
	client: (typeof clients)[keyof typeof clients]
) {
	if (!user) return 0n;
	if (asset === ADDRESS_ZERO) {
		return client.getBalance({
			address: user,
			blockTag: "latest"
		});
	} else {
		return client.readContract({
			address: asset,
			abi: ERC20_ABI,
			functionName: "balanceOf",
			args: [user]
		});
	}
}

export function getAllowance(contract: `0x${string}`) {
	return async (
		user: `0x${string}` | undefined,
		asset: `0x${string}`,
		client: (typeof clients)[keyof typeof clients]
	) => {
		if (!user) return 0n;
		if (asset == ADDRESS_ZERO) return maxUint256;
		return client.readContract({
			address: asset,
			abi: ERC20_ABI,
			functionName: "allowance",
			args: [user, contract]
		});
	};
}

const SOLANA_RPC_TIMEOUT_MS = 10_000;

export async function getSolanaBalance(
	userBase58: string | undefined,
	asset: `0x${string}`,
	connection: Connection
): Promise<bigint | null> {
	if (!userBase58) return null;
	try {
		const signal = AbortSignal.timeout(SOLANA_RPC_TIMEOUT_MS);
		const userPubkey = new PublicKey(userBase58);
		if (asset === ADDRESS_ZERO) {
			const lamports = await Promise.race([
				connection.getBalance(userPubkey),
				new Promise<never>((_, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason))
				)
			]);
			return BigInt(lamports);
		}
		const mintBytes = Buffer.from(asset.replace("0x", ""), "hex");
		const mintPubkey = new PublicKey(mintBytes);
		const tokenAccounts = await Promise.race([
			connection.getParsedTokenAccountsByOwner(userPubkey, { mint: mintPubkey }),
			new Promise<never>((_, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason))
			)
		]);
		if (tokenAccounts.value.length === 0) return 0n;
		const amount = tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
		if (typeof amount !== "string") {
			throw new Error("Unexpected Solana RPC response: missing tokenAmount in parsed account data");
		}
		return BigInt(amount);
	} catch (e) {
		console.error("getSolanaBalance failed", { userBase58, asset, error: e });
		return null;
	}
}

export async function getCompactBalance(
	user: `0x${string}` | undefined,
	asset: `0x${string}`,
	client: (typeof clients)[keyof typeof clients],
	allocatorId: string
) {
	if (!user) return 0n;
	const assetId = toId(true, ResetPeriod.OneDay, allocatorId, asset);
	try {
		return await client.readContract({
			address: COMPACT,
			abi: COMPACT_ABI,
			functionName: "balanceOf",
			args: [user, assetId]
		});
	} catch {
		return 0n;
	}
}
