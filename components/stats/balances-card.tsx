"use client";

import { useState } from "react";
import { NetworkLogo } from "@/components/network-icons";
import { formatUsd } from "@/components/wallet-data";
import { walletState } from "@/lib/stats/wallet";
import type { Network } from "@/lib/wallet/network";
import type { StatsOwedLine, StatsWallet } from "@/server/src/protocol";

/** The server names a wallet's network in words; only these have an official logo here. */
const NETWORKS: Record<string, Network> = { Arc: 5042, Polygon: 137, Solana: "solana", Ethereum: 1 };

function CopyButton({ address }: { address: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            aria-label={`Copy ${address}`}
            className="cursor-pointer rounded-full bg-pill px-2.5 py-0.5 text-[13px] font-medium text-foreground outline-2 outline-offset-2 outline-transparent focus-visible:outline-solid"
            onClick={() => {
                void navigator.clipboard?.writeText(address).then(
                    () => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                    },
                    () => {},
                );
            }}
        >
            {copied ? "Copied" : "Copy"}
        </button>
    );
}

function WalletRow({ wallet }: { wallet: StatsWallet }) {
    const { notSetUp, problem } = walletState(wallet);
    const hasDetail = wallet.address !== null || problem !== null;
    return (
        <li
            tabIndex={hasDetail ? 0 : undefined}
            className="group rounded-2xl px-3 py-2.5 outline-2 -outline-offset-2 outline-transparent focus-visible:outline-solid hover:bg-pill/60"
        >
            <div className="flex items-center gap-3">
                <NetworkLogo network={NETWORKS[wallet.network]} className="size-8" />
                <span className="min-w-0 flex-1 truncate text-[17px] font-medium tracking-[-0.01em]">
                    {wallet.label}
                    {problem && (
                        <span
                            aria-hidden="true"
                            className="ml-2 inline-block size-2 rounded-full bg-loss align-middle"
                        />
                    )}
                </span>
                <span className={`text-[17px] tabular-nums ${notSetUp ? "text-muted" : ""}`}>
                    {notSetUp ? "Not set up" : formatUsd(Number(wallet.usd))}
                </span>
            </div>
            {hasDetail && (
                <div className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-200 group-focus-within:grid-rows-[1fr] group-focus-within:opacity-100 group-hover:grid-rows-[1fr] group-hover:opacity-100">
                    <div className="min-h-0 overflow-hidden">
                        <div className="flex flex-col gap-1.5 pt-2 pl-11 text-[13px] text-muted">
                            {wallet.address && (
                                <span className="flex items-center gap-2">
                                    <span className="min-w-0 break-all select-all">{wallet.address}</span>
                                    <CopyButton address={wallet.address} />
                                </span>
                            )}
                            {problem && <span className="text-loss">{problem}</span>}
                        </div>
                    </div>
                </div>
            )}
        </li>
    );
}

/** Every wallet we hold money in, and under them what we owe. */
export function BalancesCard({ wallets, owed }: { wallets: StatsWallet[]; owed: StatsOwedLine[] }) {
    return (
        <section aria-labelledby="balances-title" className="rounded-[34px] bg-panel p-4 sm:p-6">
            <h2 id="balances-title" className="px-3 pt-2 pb-2 text-base font-medium tracking-[-0.01em] text-muted">
                Balances
            </h2>
            <ul className="flex list-none flex-col">
                {wallets.map((wallet) => (
                    <WalletRow key={wallet.id} wallet={wallet} />
                ))}
            </ul>
            <ul className="mt-3 flex list-none flex-col border-t border-foreground/10 pt-3">
                {owed.map((line) => (
                    <li
                        key={line.id}
                        className="flex items-center justify-between gap-3 px-3 py-1.5 text-[15px] text-muted"
                    >
                        <span className="truncate">{line.label}</span>
                        <span className="tabular-nums">{formatUsd(Number(line.usd))}</span>
                    </li>
                ))}
            </ul>
        </section>
    );
}
