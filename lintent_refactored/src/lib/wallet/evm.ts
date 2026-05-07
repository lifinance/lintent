import { http, createConfig } from "wagmi";
import { injected, metaMask, walletConnect } from "wagmi/connectors";
import {
  ethereum, base, arbitrum, megaeth, katana, polygon, bsc,
  sepolia, baseSepolia, arbitrumSepolia, optimismSepolia,
} from "../config/evm";

const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ?? "";

export const wagmiConfig = createConfig({
  chains: [
    ethereum, base, arbitrum, polygon, bsc, katana, megaeth,
    sepolia, baseSepolia, arbitrumSepolia, optimismSepolia,
  ],
  connectors: [
    injected(),
    metaMask(),
    ...(WC_PROJECT_ID ? [walletConnect({ projectId: WC_PROJECT_ID })] : []),
  ],
  transports: {
    [ethereum.id]: http(),
    [base.id]: http(),
    [arbitrum.id]: http(),
    [polygon.id]: http(),
    [bsc.id]: http(),
    [katana.id]: http(),
    [megaeth.id]: http(),
    [sepolia.id]: http(),
    [baseSepolia.id]: http(),
    [arbitrumSepolia.id]: http(),
    [optimismSepolia.id]: http(),
  },
});
