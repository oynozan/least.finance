"use client";

import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";

const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const clientId = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID || undefined;

/** False when no Privy app ID is set, e.g. a fresh clone without `.env.local`. */
export const walletEnabled = Boolean(appId);

export function WalletProvider({ children }: { children: ReactNode }) {
  // Privy throws on an empty app ID, so the page still renders without one.
  if (!appId) return children;

  return (
    <PrivyProvider
      appId={appId}
      clientId={clientId}
      config={{
        loginMethods: ["wallet"],
        appearance: {
          theme: "#222220",
          accentColor: "#468df7",
          walletChainType: "ethereum-only",
          showWalletLoginFirst: true,
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
