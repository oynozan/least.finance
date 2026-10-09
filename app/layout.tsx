import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { AccountProvider } from "@/components/account-provider";
import { ConnectWallet } from "@/components/connect-wallet";
import { Dock } from "@/components/dock";
import { SidebarShell } from "@/components/sidebar";
import { ReviewPanel } from "@/components/trade/review-panel";
import { TradeProvider } from "@/components/trade/trade-provider";
import { WalletProvider } from "@/components/wallet-provider";
import { WalletSidebar } from "@/components/wallet-sidebar";
import "./globals.css";
import "./privy.css";

const inter = Inter({
    variable: "--font-sans",
    subsets: ["latin"],
});

export const metadata: Metadata = {
    title: "Trade Everything",
    description: "Trade with one sentence: swap, buy, sell, go long or short, or predict.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
    return (
        <html lang="en" className={inter.variable}>
            <body>
                <WalletProvider>
                    <AccountProvider>
                        <TradeProvider>
                            <SidebarShell panel={<WalletSidebar />} review={<ReviewPanel />}>
                                {children}
                                {/* On every page: the wallet up top, the dock at the bottom. */}
                                <ConnectWallet />
                                <Dock />
                            </SidebarShell>
                        </TradeProvider>
                    </AccountProvider>
                </WalletProvider>
            </body>
        </html>
    );
}
