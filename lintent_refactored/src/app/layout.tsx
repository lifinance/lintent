import { type ReactElement } from "react";
import type { Metadata } from "next";
import { Providers } from "./providers.tsx";
import { NavBar } from "../components/shared/NavBar.tsx";

export const metadata: Metadata = {
  title: "Lintent — Cross-chain Intent Protocol",
  description: "Create and fill cross-chain intents on EVM and Solana",
};

type RootLayoutProps = {
  children: React.ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps): ReactElement {
  return (
    <html lang="en">
      <body>
        <Providers>
          <NavBar />
          {children}
        </Providers>
      </body>
    </html>
  );
}
