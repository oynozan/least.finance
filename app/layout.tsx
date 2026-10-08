import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { SidebarShell } from "@/components/sidebar";
import { WalletProvider } from "@/components/wallet-provider";
import { WalletSidebar } from "@/components/wallet-sidebar";
import "./globals.css";
import "./privy.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Create visual languages",
  description:
    "A tool to create visual languages, customize type, and build interfaces with Cursor.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <WalletProvider>
          <SidebarShell panel={<WalletSidebar />}>{children}</SidebarShell>
        </WalletProvider>
      </body>
    </html>
  );
}
