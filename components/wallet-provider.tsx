"use client";

import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { bsc, mainnet } from "viem/chains";
import { arc } from "./arc";

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
                // No default chain, which would have Privy switch every wallet on connect; these are the networks a deposit can switch to.
                supportedChains: [arc, mainnet, bsc],
                // Coinbase's smart wallet only runs on its own chain list, so offer the extension and app instead.
                externalWallets: {
                    coinbaseWallet: { config: { preference: { options: "eoaOnly" } } },
                    solana: { connectors: toSolanaWalletConnectors() },
                },
                appearance: {
                    // Base colors only; app/privy.css redefines the full palette.
                    theme: "#222220",
                    accentColor: "#f5f5f3",
                    walletChainType: "ethereum-and-solana",
                    showWalletLoginFirst: true,
                    // Wallets that can add Arc; detected extensions bring in Rabby, and any other installed wallet too.
                    walletList: [
                        "detected_ethereum_wallets",
                        "metamask",
                        "rainbow",
                        "coinbase_wallet",
                        "wallet_connect",
                        "detected_solana_wallets",
                        "phantom",
                        "solflare",
                        "backpack",
                    ],
                },
            }}
        >
            {children}
        </PrivyProvider>
    );
}
