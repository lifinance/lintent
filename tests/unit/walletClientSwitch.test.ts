import { describe, expect, it, mock } from "bun:test";
import type { EIP1193Provider } from "viem";
import { createSwitchWalletChain } from "../../src/lib/utils/walletClient";

describe("switchWalletChain", () => {
  it("uses walletClient.switchChain when available", async () => {
    const getCurrentProvider = mock(async () => undefined);
    const switchWalletChain = createSwitchWalletChain({ getCurrentProvider });
    const switchChain = mock(async () => undefined);
    const walletClient = { switchChain } as unknown as Parameters<typeof switchWalletChain>[0];
    await switchWalletChain(walletClient, 8453);
    expect(switchChain).toHaveBeenCalledWith({ id: 8453 });
    expect(getCurrentProvider).not.toHaveBeenCalled();
  });

  it("falls back to provider wallet_switchEthereumChain", async () => {
    const getCurrentProvider = mock(async () => undefined);
    const switchWalletChain = createSwitchWalletChain({ getCurrentProvider });
    const request = mock(async () => null);
    const walletClient = {} as unknown as Parameters<typeof switchWalletChain>[0];
    const provider = { request } as unknown as NonNullable<
      Parameters<typeof switchWalletChain>[2]
    >["provider"];
    await switchWalletChain(walletClient, 8453, { provider });
    expect(request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }]
    });
    expect(getCurrentProvider).not.toHaveBeenCalled();
  });

  it("falls back to injected getCurrentProvider when no provider is passed", async () => {
    const request = mock(async () => null);
    const provider = { request } as unknown as EIP1193Provider;
    const getCurrentProvider = mock(async () => provider);
    const switchWalletChain = createSwitchWalletChain({ getCurrentProvider });
    const walletClient = {} as unknown as Parameters<typeof switchWalletChain>[0];

    await switchWalletChain(walletClient, 8453);

    expect(getCurrentProvider).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }]
    });
  });

  it("throws when no provider can be resolved", async () => {
    const getCurrentProvider = mock(async () => undefined);
    const switchWalletChain = createSwitchWalletChain({ getCurrentProvider });
    const walletClient = {} as unknown as Parameters<typeof switchWalletChain>[0];

    await expect(switchWalletChain(walletClient, 8453)).rejects.toThrow(
      "Wallet client does not support switchChain and no provider is available for chain 8453."
    );
  });
});
