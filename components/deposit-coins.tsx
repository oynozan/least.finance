"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion, type Transition, type Variants } from "motion/react";
import { sameWallet } from "@/lib/account/balances";
import type { CoinBalance } from "@/server/src/protocol";
import { CoinIcon } from "./coin-icons";
import { EVM_CATALOG, SOLANA_CATALOG } from "./deposit-coins-catalog";
import { CloseIcon, PlusIcon } from "./icons";
import { NetworkLogo } from "./network-icons";
import { trackScrollEdges } from "./scroll-edges";
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

const frameSpring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };
const rowSpring: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.35 };
const slide: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.25 };

const listVariants: Variants = {
    hidden: {},
    shown: { transition: { staggerChildren: 0.025, delayChildren: 0.05 } },
};

const rowVariants: Variants = {
    hidden: { opacity: 0, y: 10, scale: 0.96 },
    shown: { opacity: 1, y: 0, scale: 1, transition: rowSpring },
};

/** Room kept under the list, inside the sidebar, for the frame's padding and shadow. */
const BOTTOM_ROOM = 22;

/** Arc, Ethereum and BNB Chain can be deposited from; Solana can't yet. */
const isOpen = (row: CoinBalance) => row.chain !== "solana";

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

/** Caps the list at the sidebar's bottom edge, so a long one scrolls, and fades the edges it scrolls past. */
function listRef(list: HTMLUListElement | null) {
    const panel = list?.closest("aside");
    if (!list || !panel) return;
    const fit = () => {
        const room = panel.getBoundingClientRect().bottom - list.getBoundingClientRect().top - BOTTOM_ROOM;
        list.style.maxHeight = `${Math.max(room, 0)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    const untrack = trackScrollEdges(list);
    return () => {
        window.removeEventListener("resize", fit);
        untrack?.();
    };
}

/** The list of every supported coin in the person's wallets, to pick what to deposit. */
export function DepositCoins({ rows, wallets, onPick, onConnect, onClose }: DepositCoinsProps) {
    const frame = useRef<HTMLDivElement>(null);
    // The row under the pointer or keyboard focus; one highlight for the whole list slides between them.
    const [active, setActive] = useState<string | null>(null);
    const rowEls = useRef(new Map<string, HTMLButtonElement>());
    // The active row's layout box (offsets ignore the rows' entrance transforms). Kept after the
    // pointer leaves, so the highlight fades out where it was.
    const [box, setBox] = useState<{ top: number; height: number } | null>(null);
    useLayoutEffect(() => {
        const row = active ? rowEls.current.get(active) : undefined;
        if (row) setBox({ top: row.offsetTop, height: row.offsetHeight });
    }, [active]);
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

    const all = wallets.flatMap((wallet) => rowsOf(wallet, rows));
    // What can be deposited first, then empty coins, then networks that aren't open yet.
    const groups = [
        { label: null, rows: byValue(all.filter((row) => isOpen(row) && !isZero(row))) },
        { label: "Nothing to deposit", rows: byValue(all.filter((row) => isOpen(row) && isZero(row))) },
        { label: "Not open yet", rows: byValue(all.filter((row) => !isOpen(row))) },
    ].filter((group) => group.rows.length > 0);
    const crowded = (kind: WalletRef["kind"]) => wallets.filter((wallet) => wallet.kind === kind).length > 1;
    // The wallet as the header spells it, not as the server's checksummed copy does.
    const shown = (row: CoinBalance) =>
        wallets.find((w) => (row.chain === "solana" ? w.address === row.wallet : sameWallet(w.address, row.wallet)))
            ?.address ?? row.wallet;
    const missing = (["evm", "solana"] as const).filter((kind) => !wallets.some((wallet) => wallet.kind === kind));

    const track = (key: string) => ({
        ref: (node: HTMLButtonElement | null) => {
            if (node) rowEls.current.set(key, node);
            else rowEls.current.delete(key);
        },
        onPointerMove: () => setActive(key),
        onFocus: (event: React.FocusEvent) => event.currentTarget.matches(":focus-visible") && setActive(key),
    });

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
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.14, ease: "easeIn" } }}
            transition={frameSpring}
        >
            <div className={styles.coinsHead}>
                <span>Coins to deposit</span>
                <motion.button
                    type="button"
                    className={styles.coinsClose}
                    aria-label="Close coin list"
                    title="Close"
                    whileHover={{ scale: 1.08 }}
                    whileTap={{ scale: 0.9 }}
                    transition={rowSpring}
                    onClick={close}
                >
                    <CloseIcon />
                </motion.button>
            </div>
            <motion.ul
                className={`${styles.history} ${styles.coins}`}
                aria-label="Coins to deposit"
                ref={listRef}
                variants={listVariants}
                initial="hidden"
                animate="shown"
                onPointerLeave={() => setActive(null)}
                onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setActive(null);
                }}
            >
                {/* The list's bottom layer: a negative z-index inside the isolated
                    list paints below every row, label and group header, wherever
                    it slides. */}
                {box && (
                    <motion.li
                        aria-hidden="true"
                        data-highlight=""
                        className={styles.coinHighlight}
                        initial={{ opacity: 0, y: box.top, height: box.height }}
                        animate={{ opacity: active ? 1 : 0, y: box.top, height: box.height }}
                        transition={{ ...slide, opacity: { duration: 0.15 } }}
                    />
                )}
                {groups.map((group) => [
                    group.label && (
                        <motion.li
                            key={`group:${group.label}`}
                            className={styles.coinsGroup}
                            aria-hidden="true"
                            variants={rowVariants}
                        >
                            {group.label}
                        </motion.li>
                    ),
                    ...group.rows.map((row) => {
                        const key = `${row.wallet}:${row.coin}`;
                        const open = isOpen(row);
                        const zero = isZero(row);
                        const blocked = !open || zero;
                        const suffix = crowded(row.chain === "solana" ? "solana" : "evm")
                            ? shortenAddress(shown(row))
                            : null;
                        const label =
                            `${row.symbol} on ${row.chainName}` +
                            (row.amount !== null ? `, ${formatAmount(row.amount)} ${row.symbol}` : "") +
                            (row.usd !== null ? `, ${formatUsd(row.usd)}` : "") +
                            (suffix ? `, ${suffix}` : "");
                        return (
                            <motion.li key={key} variants={rowVariants}>
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
                                    {...track(key)}
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
                                            {suffix && `, ${suffix}`}
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
                            </motion.li>
                        );
                    }),
                ])}
                {missing.length > 0 && (
                    <motion.li className={styles.coinsDivider} aria-hidden="true" variants={rowVariants} />
                )}
                {missing.map((kind) => (
                    <motion.li key={kind} variants={rowVariants}>
                        <button
                            type="button"
                            className={styles.coinRow}
                            aria-label={kind === "solana" ? "Connect a Solana wallet" : "Connect an EVM wallet"}
                            data-connect
                            {...track(`connect:${kind}`)}
                            onClick={() => onConnect(kind)}
                        >
                            <ConnectMark network={kind === "solana" ? "solana" : 1} />
                            <span className={styles.coinName}>
                                {kind === "solana" ? "Connect a Solana wallet" : "Connect an EVM wallet"}
                                <span className={styles.coinChain}>
                                    {kind === "solana"
                                        ? "To deposit SOL and USDC"
                                        : "To deposit from Ethereum, BNB Chain or Arc"}
                                </span>
                            </span>
                        </button>
                    </motion.li>
                ))}
            </motion.ul>
        </motion.div>
    );
}

/** The network's logo in a round tile, with a plus: a wallet still to add. */
function ConnectMark({ network }: { network: "solana" | 1 }): ReactNode {
    return (
        <span className={`${styles.coinMark} ${styles.connectMark}`} aria-hidden="true">
            <NetworkLogo network={network} className={styles.connectLogo} />
            <span className={styles.connectPlus}>
                <PlusIcon />
            </span>
        </span>
    );
}
