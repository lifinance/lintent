import { PublicKey } from "@solana/web3.js";

/** Convert a Base58 Solana public key to a 0x-prefixed 32-byte hex string. */
export function solanaAddressToBytes32(base58: string): `0x${string}` {
	const bytes = new PublicKey(base58).toBytes();
	return `0x${Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")}`;
}

/** Returns true if the string is a valid Base58 Solana public key. */
export function isValidSolanaAddress(address: string): boolean {
	try {
		new PublicKey(address);
		return true;
	} catch {
		return false;
	}
}
