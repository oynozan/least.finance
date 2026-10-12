"use client";

import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { sameWallet } from "@/lib/account/balances";
import type { CoinBalance } from "@/server/src/protocol";
import { CoinIcon } from "./coin-icons";
import { EVM_CATALOG, SOLANA_CATALOG } from "./deposit-coins-catalog";
import { CloseIcon } from "./icons";
import { NetworkLogo } from "./network-icons";
import { formatUsd, shortenAddress } from "./wallet-data";
import styles from "./wallet-sidebar.module.css";

type WalletRef = { kind: "evm" | "solana"; address: string };

type DepositCoinsProps = {
    /** Null before any read: every catalog coin of every linked wallet, without amounts. */
    rows: CoinBalance[] | null;
    wallets: WalletRef[];
    onPick: (row: CoinBalance) => void;
    onConnect: (kind: "evm" | "solana") => void;
    onClose: () => void;
};

/** Only USDC on Arc can be deposited so far. */
const isOpen = (row: CoinBalance) => row.coin === "arc:USDC";

const isZero = (row: CoinBalance) => row.amount !== null && Number(row.amount) === 0;

/** The wallet's rows if it has any, else its catalog coins without amounts. */
function rowsOf(wallet: WalletRef, rows: CoinBalance[] | null): CoinBalance[] {
    const own = rows?.filter((row) => sameWallet(row.wallet, wallet.address)) ?? [];
    if (own.length > 0) return own;
    return (wallet.kind === "solana" ? SOLANA_CATALOG : EVM_CATALOG).map((coin) => ({
        ...coin,
        wallet: wallet.address,
        amount: null,
        spendable: null,
        usd: null,
    }));
}

/** Highest value first; rows without one keep their order at the end. */
const byValue = (list: CoinBalance[]) => {
    const known = list.filter((row) => row.usd !== null).sort((a, b) => b.usd! - a.usd!);
    return [...known, ...list.filter((row) => row.usd === null)];
};

/** The amount cut to six decimals, never rounded up past what the wallet holds. */
function formatAmount(amount: string) {
    const [whole = "0", fraction = ""] = amount.split(".");
    const cut = fraction.slice(0, 6).replace(/0+$/, "");
    if (!cut && /[1-9]/.test(fraction)) return "<0.000001";
    return cut ? `${Number(whole).toLocaleString("en-US")}.${cut}` : Number(whole).toLocaleString("en-US");
}

/** Caps the list at the sidebar's bottom edge, so a long one scrolls. */
function fitToPanel(list: HTMLUListElement | null) {
    const panel = list?.closest("aside");
    if (!list || !panel) return;
    const fit = () => {
        const room = panel.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
        list.style.maxHeight = `${Math.max(room, 0)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
}

/** The list of every supported coin in the person's wallets, to pick what to deposit. */
export function DepositCoins({ rows, wallets, onPick, onConnect, onClose }: DepositCoinsProps) {
    const frame = useRef<HTMLDivElement>(null);
    // The Deposit button that opened the list, which gets focus back when it closes.
    const opener = useRef<Element | null>(null);
    useEffect(() => {
        opener.current = document.activeElement;
        frame.current?.focus();
    }, []);
    const close = () => {
        onClose();
        if (opener.current instanceof HTMLElement) opener.current.focus();
    };

    const list = byValue(wallets.flatMap((wallet) => rowsOf(wallet, rows)));
    const crowded = (kind: WalletRef["kind"]) => wallets.filter((wallet) => wallet.kind === kind).length > 1;
    const missing = (["evm", "solana"] as const).filter((kind) => !wallets.some((wallet) => wallet.kind === kind));

    return (
        <motion.div
            ref={frame}
            tabIndex={-1}
            className={`${styles.historyFrame} ${styles.coinsFrame}`}
            onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                // The sidebar closes on Escape too; this is only the list.
                event.stopPropagation();
                close();
            }}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", visualDuration: 0.3, bounce: 0.2 }}
        >
            <div className={styles.coinsHead}>
                <span>Coins to deposit</span>
                <button type="button" className={styles.coinsClose} aria-label="Close coin list" onClick={close}>
                    <CloseIcon />
                </button>
            </div>
            <ul className={styles.history} aria-label="Coins to deposit" ref={fitToPanel}>
                {list.map((row) => {
                    const open = isOpen(row);
                    const zero = isZero(row);
                    const blocked = !open || zero;
                    const suffix = crowded(row.chain === "solana" ? "solana" : "evm")
                        ? shortenAddress(row.wallet)
                        : null;
                    const label =
                        `${row.symbol} on ${row.chainName}` +
                        (row.amount !== null ? `, ${formatAmount(row.amount)} ${row.symbol}` : "") +
                        (row.usd !== null ? `, ${formatUsd(row.usd)}` : "") +
                        (suffix ? ` · ${suffix}` : "");
                    return (
                        <li key={`${row.wallet}:${row.coin}`}>
                            <button
                                type="button"
                                className={styles.coinRow}
                                aria-label={label}
                                aria-disabled={blocked || undefined}
                                data-dim={zero || undefined}
                                title={
                                    !open
                                        ? `Deposits from ${row.chainName} aren't open yet.`
                                        : zero
                                          ? "Nothing to deposit"
                                          : undefined
                                }
                                onClick={() => !blocked && onPick(row)}
                            >
                                <span className={styles.coinMark}>
                                    <CoinIcon symbol={row.symbol} className={styles.coinIcon} />
                                    <NetworkLogo network={row.chainId ?? "solana"} className={styles.coinBadge} />
                                </span>
                                <span className={styles.coinName}>
                                    {row.symbol}
                                    <span className={styles.coinChain}>
                                        {row.chainName}
                                        {suffix && ` · ${suffix}`}
                                    </span>
                                </span>
                                {row.amount !== null && (
                                    <span className={styles.coinAmount}>
                                        {formatAmount(row.amount)}
                                        {row.usd !== null && (
                                            <span className={styles.coinChain}>{formatUsd(row.usd)}</span>
                                        )}
                                    </span>
                                )}
                            </button>
                        </li>
                    );
                })}
                {missing.map((kind) => (
                    <li key={kind}>
                        <button type="button" className={styles.coinRow} data-connect onClick={() => onConnect(kind)}>
                            <span className={styles.coinName}>
                                {kind === "solana" ? "Connect a Solana wallet" : "Connect an EVM wallet"}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </motion.div>
    );
}
