import { create } from "zustand";
import type { Vm } from "../types/shared";

export type SelectedChainToken = {
  chainId: number;
  tokenAddress: string;
  tokenName: string;
  tokenDecimals: number;
  amount: bigint;
};

type SelectionState = {
  mainnet: boolean;
  inputVm: Vm | null;
  inputChains: SelectedChainToken[];
  outputChains: SelectedChainToken[];
  setMainnet: (mainnet: boolean) => void;
  setInputVm: (vm: Vm) => void;
  setInputChains: (chains: SelectedChainToken[]) => void;
  setOutputChains: (chains: SelectedChainToken[]) => void;
  resetSelection: () => void;
};

export const useSelectionStore = create<SelectionState>((set) => ({
  mainnet: false,
  inputVm: null,
  inputChains: [],
  outputChains: [],
  setMainnet: (mainnet) => set({ mainnet }),
  setInputVm: (inputVm) => set({ inputVm }),
  setInputChains: (inputChains) => set({ inputChains }),
  setOutputChains: (outputChains) => set({ outputChains }),
  resetSelection: () => set({ inputVm: null, inputChains: [], outputChains: [] }),
}));
