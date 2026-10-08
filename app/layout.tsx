import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { WalletProvider } from "@/components/wallet-provider";
import "./globals.css";

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
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
