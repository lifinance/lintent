import type { EIP1193Provider } from "viem";
import { toHex } from "viem";
import type { WC } from "$lib/config";

export type SwitchableWalletClient = WC & {
  switchChain?: (args: { id: number }) => Promise<unknown>;
};

export type SwitchWalletChainOptions = {
  provider?: EIP1193Provider;
};

export type SwitchWalletChain = (
  walletClient: WC | undefined,
  chainId: number,
  options?: SwitchWalletChainOptions
) => Promise<void>;

export type SwitchWalletChainDeps = {
  getCurrentProvider: () => Promise<EIP1193Provider | undefined>;
};

async function resolveWalletProvider(
  walletClient: WC | undefined,
  deps: SwitchWalletChainDeps,
  provider?: EIP1193Provider
): Promise<EIP1193Provider | undefined> {
  if (provider?.request) return provider;

  const walletClientWithTransport = walletClient as
    | (WC & { transport?: { value?: EIP1193Provider } })
    | undefined;
  const transportProvider = walletClientWithTransport?.transport?.value;
  if (transportProvider?.request) return transportProvider;

  try {
    return await deps.getCurrentProvider();
  } catch {
    return undefined;
  }
}

export function createSwitchWalletChain(deps: SwitchWalletChainDeps): SwitchWalletChain {
  return async (
    walletClient: WC | undefined,
    chainId: number,
    options?: SwitchWalletChainOptions
  ) => {
    if (!walletClient) return;

    const switchableClient = walletClient as SwitchableWalletClient;
    if (typeof switchableClient.switchChain === "function") {
      await switchableClient.switchChain({ id: chainId });
      return;
    }

    const provider = await resolveWalletProvider(walletClient, deps, options?.provider);
    if (!provider?.request) {
      throw new Error(
        `Wallet client does not support switchChain and no provider is available for chain ${chainId}.`
      );
    }

    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: toHex(chainId) }]
    });
  };
}
