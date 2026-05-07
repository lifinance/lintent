"use client";

import { useSelectionStore } from "../../store/index";
import type { SelectedChainToken } from "../../store/selection";
import type { Vm } from "../../types/shared";

type UseChainSelectionReturn = {
  mainnet: boolean;
  inputVm: Vm | null;
  inputChains: SelectedChainToken[];
  outputChains: SelectedChainToken[];
  setMainnet: (v: boolean) => void;
  setInputVm: (vm: Vm) => void;
  setInputChains: (chains: SelectedChainToken[]) => void;
  addInputChain: (chain: SelectedChainToken) => void;
  removeInputChain: (chainId: number) => void;
  updateInputChain: (chainId: number, updates: Partial<SelectedChainToken>) => void;
  addOutputChain: (chain: SelectedChainToken) => void;
  removeOutputChain: (chainId: number) => void;
  updateOutputChain: (chainId: number, updates: Partial<SelectedChainToken>) => void;
  resetSelection: () => void;
};

export function useChainSelection(): UseChainSelectionReturn {
  const store = useSelectionStore();

  const addInputChain = (chain: SelectedChainToken): void => {
    store.setInputChains([...store.inputChains, chain]);
  };

  const removeInputChain = (chainId: number): void => {
    store.setInputChains(store.inputChains.filter((c) => c.chainId !== chainId));
  };

  const updateInputChain = (chainId: number, updates: Partial<SelectedChainToken>): void => {
    store.setInputChains(
      store.inputChains.map((c) => (c.chainId === chainId ? { ...c, ...updates } : c)),
    );
  };

  const addOutputChain = (chain: SelectedChainToken): void => {
    store.setOutputChains([...store.outputChains, chain]);
  };

  const removeOutputChain = (chainId: number): void => {
    store.setOutputChains(store.outputChains.filter((c) => c.chainId !== chainId));
  };

  const updateOutputChain = (chainId: number, updates: Partial<SelectedChainToken>): void => {
    store.setOutputChains(
      store.outputChains.map((c) => (c.chainId === chainId ? { ...c, ...updates } : c)),
    );
  };

  return {
    mainnet: store.mainnet,
    inputVm: store.inputVm,
    inputChains: store.inputChains,
    outputChains: store.outputChains,
    setMainnet: store.setMainnet,
    setInputVm: store.setInputVm,
    setInputChains: store.setInputChains,
    addInputChain,
    removeInputChain,
    updateInputChain,
    addOutputChain,
    removeOutputChain,
    updateOutputChain,
    resetSelection: store.resetSelection,
  };
}
