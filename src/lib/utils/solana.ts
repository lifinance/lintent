import { base58 } from "@scure/base";

export function isValidSolanaAddress(addr: string): boolean {
	try {
		const bytes = base58.decode(addr);
		return bytes.length === 32;
	} catch {
		return false;
	}
}

export function solanaAddressToBytes32(addr: string): `0x${string}` {
	const bytes = base58.decode(addr);
	if (bytes.length !== 32) throw new Error(`Invalid Solana address: ${addr}`);
	return `0x${Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")}`;
}
