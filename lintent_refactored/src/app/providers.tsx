"use client";
import { type ReactElement } from "react";

import { type ReactNode, useState } from "react";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-appRouter";
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { theme } from "./theme.ts";
import { wagmiConfig } from "../lib/wallet/evm.ts";
import { SolanaWalletProviders } from "../lib/wallet/svm.tsx";

type ProvidersProps = {
  children: ReactNode;
};

export function Providers({ children }: ProvidersProps): ReactElement {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <AppRouterCacheProvider>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <SolanaWalletProviders>
              {children}
            </SolanaWalletProviders>
          </QueryClientProvider>
        </WagmiProvider>
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
