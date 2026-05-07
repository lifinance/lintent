"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import type { Connector } from "wagmi";

type UseEvmWalletReturn = {
  address: `0x${string}` | undefined;
  chainId: number | undefined;
  isConnected: boolean;
  connectors: readonly Connector[];
  connect: (connector: Connector) => void;
  disconnect: () => void;
  switchChain: (chainId: number) => void;
};

export function useEvmWallet(): UseEvmWalletReturn {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain: switchChainWagmi } = useSwitchChain();

  const switchChain = (targetChainId: number): void => {
    switchChainWagmi({ chainId: targetChainId });
  };

  const connectWith = (connector: Connector): void => {
    connect({ connector });
  };

  return { address, chainId, isConnected, connectors, connect: connectWith, disconnect, switchChain };
}
