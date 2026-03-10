import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import type { WalletAdapter } from "@solana/wallet-adapter-base";

export const AVAILABLE_WALLETS = [
	{ name: "Phantom", adapter: new PhantomWalletAdapter() },
	{ name: "Solflare", adapter: new SolflareWalletAdapter() }
] as const;

class SolanaWalletStore {
	#adapter = $state<WalletAdapter | null>(null);
	#connected = $state(false);
	#publicKey = $state<string | null>(null);

	get adapter(): WalletAdapter | null {
		return this.#adapter;
	}

	get connected(): boolean {
		return this.#connected;
	}

	/** Base58-encoded public key of the connected wallet, or null */
	get publicKey(): string | null {
		return this.#publicKey;
	}

	async connect(adapter: WalletAdapter): Promise<void> {
		if (this.#adapter?.connected) {
			this.#adapter.off("connect");
			this.#adapter.off("disconnect");
			await this.#adapter.disconnect();
		}
		this.#adapter = adapter;
		adapter.on("connect", (pk) => {
			this.#connected = true;
			this.#publicKey = pk.toBase58();
		});
		adapter.on("disconnect", () => {
			this.#connected = false;
			this.#publicKey = null;
		});
		await adapter.connect();
	}

	async disconnect(): Promise<void> {
		if (this.#adapter) {
			this.#adapter.off("connect");
			this.#adapter.off("disconnect");
			await this.#adapter.disconnect();
		}
		this.#adapter = null;
		this.#connected = false;
		this.#publicKey = null;
	}
}

const solanaWallet = new SolanaWalletStore();
export default solanaWallet;
