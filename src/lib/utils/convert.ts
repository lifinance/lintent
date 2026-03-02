// --- Type conversion helpers --- //

import { checksumAddress } from "viem";
import bs58 from "bs58";

export function solanaAddressToBytes32(base58Address: string): `0x${string}` {
	const decoded = bs58.decode(base58Address);
	if (decoded.length !== 32) {
		throw new Error(`Invalid Solana address: expected 32 bytes, got ${decoded.length}`);
	}
	const hex = Array.from(decoded)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `0x${hex}`;
}

export function isValidSolanaAddress(value: string): boolean {
	try {
		const decoded = bs58.decode(value.trim());
		return decoded.length === 32;
	} catch {
		return false;
	}
}

export function toBigIntWithDecimals(value: number, decimals: number): bigint {
	// Convert number to string in full precision
	const [intPart, decPart = ""] = value.toString().split(".");

	// Take up to `decimals` digits of the decimal part
	const truncatedDec = decPart.slice(0, decimals);

	// Pad the decimal part to ensure we have exactly `decimals` digits
	const paddedDec = truncatedDec.padEnd(decimals, "0");

	// Remove leading zeros from intPart just in case
	const normalizedInt = intPart.replace(/^(-?)0+(?=\d)/, "$1");
	// Combine parts
	const combined = (normalizedInt + paddedDec).replace(".", "");

	return BigInt(combined);
}

export function addressToBytes32(address: `0x${string}`): `0x${string}` {
	const raw = address.replace("0x", "");
	if (raw.length !== 40 && raw.length !== 64) {
		throw new Error(`Invalid address length: ${address.length}`);
	}
	return `0x${raw.padStart(64, "0")}`;
}

export function bytes32ToAddress(bytes: `0x${string}`): `0x${string}` {
	if (bytes.length != 66 && bytes.length != 64) {
		throw new Error(`Invalid bytes length: ${bytes.length}`);
	}
	return `0x${bytes.replace("0x", "").slice(24, 64)}`;
}

export function idToToken(id: `0x${string}` | bigint): `0x${string}` {
	if (typeof id === "string" && id.indexOf("0x") != 0) {
		id = BigInt(id);
	}
	if (typeof id === "bigint") {
		// Convert bigint to hex string and pad it to 64 characters.
		id = `0x${id.toString(16).padStart(64, "0")}`;
	}
	// Remove the first 12 bytes (24 hex characters) and keep the last 20 bytes (40 hex characters).
	return checksumAddress(bytes32ToAddress(id));
}

export function trunc(value: `0x${string}`, length: number = 6): `0x${string}...${string}` {
	return `0x${value.replace("0x", "").slice(0, length)}...${value
		.replace("0x", "")
		.slice(-length)}`;
}
