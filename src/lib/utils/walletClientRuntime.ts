import { createSwitchWalletChain } from "./walletClient";
import { getCurrentProvider } from "./wagmi";

export const switchWalletChain = createSwitchWalletChain({ getCurrentProvider });
