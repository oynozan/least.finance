"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePrivy } from "@privy-io/react-auth";
import {
    AnimatePresence,
    MotionConfig,
    animate,
    motion,
    useMotionValue,
    useReducedMotion,
    useTransform,
    type Transition,
    type Variants,
} from "motion/react";
import { sameWallet as sameAddress } from "@/lib/account/balances";
import { toUsdc, type HistoryRow } from "@/lib/account/state";
import type { ApiError, DepositQuoteView } from "@/lib/account/state";
import type { CoinBalance, DepositOrderView } from "@/server/src/protocol";
import type { DepositNotice, DepositResult } from "./account-client";
import { useAccount } from "./account-provider";
import {
    depositWalletAddress,
    linkedWallets,
    useActiveWallet,
    useLinkOtherWallet,
    useUsdcBalance,
    useWalletNetwork,
    type Wallet,
} from "./arc-wallet";
import { CoinIcon } from "./coin-icons";
import { DepositButton } from "./deposit-button";
import { DepositCoins } from "./deposit-coins";
import { coinLabel } from "./deposit-coins-catalog";
import { DepositForm } from "./deposit-form";
import { DepositProgress, isRunning, shownOrder } from "./deposit-progress";
import { CloseIcon, PlusIcon, PowerIcon } from "./icons";
import { NetworkLogo } from "./network-icons";
import { canHover } from "./pointer";
import { PositionRow } from "./position-row";
import { trackScrollEdges } from "./scroll-edges";
import { useSidebar } from "./sidebar";
import { MOCK_POSITIONS, formatUsd, formatWhen, shortenAddress } from "./wallet-data";
import { walletEnabled } from "./wallet-provider";
import styles from "./wallet-sidebar.module.css";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };
const settle: Transition = { type: "spring", visualDuration: 0.4, bounce: 0.15 };

// Rows rise bottom-up once the panel has mostly arrived. Only the top rows
// (the ones in view when the list overflows) take part in the stagger;
// rows further down land straight away, out of sight.
const STAGGERED_ROWS = 8;
const entranceDelay = (index: number, count: number) =>
    0.12 + Math.max(0, index - Math.max(0, count - STAGGERED_ROWS)) * 0.03;

/** How long a finished bridged deposit stays under the button. */
const ENDED_VISIBLE_MS = 10_000;

const deal: Transition = { type: "spring", visualDuration: 0.2, bounce: 0.25 };

// Collapsed, every deposit hides up under the one above it, a little
// smaller each step back; revealing deals them out into a list. Depth and
// stagger stop growing after the first few rows, so a long history still
// reveals as quickly as a short one (and never scales a row past zero).
const depositRow: Variants = {
    hidden: (i: number) => {
        const depth = Math.min(i + 1, 4);
        return {
            opacity: 0,
            y: -18 * depth,
            scale: 1 - 0.05 * depth,
            filter: "blur(4px)",
            // Bottom rows tuck away first.
            transition: { duration: 0.12, ease: "easeIn", delay: (3 - Math.min(i, 3)) * 0.02 },
        };
    },
    shown: (i: number) => ({
        opacity: 1,
        y: 0,
        scale: 1,
        filter: "blur(0px)",
        transition: { ...deal, delay: Math.min(i, 7) * 0.03 },
    }),
};

/** Caps the history at the sidebar's bottom edge, so a long one scrolls. */
function fitToPanel(list: HTMLOListElement | null) {
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

function historyRef(list: HTMLOListElement | null) {
    const unfit = fitToPanel(list);
    const untrack = trackScrollEdges(list);
    return () => {
        unfit?.();
        untrack?.();
    };
}

/** The sidebar's content. Renders nothing until a wallet is signed in. */
export function WalletSidebar() {
    if (!walletEnabled) return null;
    return <SignedInWallet />;
}

function SignedInWallet() {
    const { ready, authenticated, logout, user } = usePrivy();
    const { open, setOpen } = useSidebar();
    const active = useActiveWallet();
    const linkOther = useLinkOtherWallet();
    const address = active.address;
    const linked = user ? linkedWallets(user) : [];
    const hasEvm = linked.some((wallet) => wallet.kind === "evm");
    // The kind they don't have yet; EVM if they have both.
    const otherKind = hasEvm && !linked.some((wallet) => wallet.kind === "solana") ? "solana" : "evm";

    // Signing out from anywhere also folds the sidebar away.
    useEffect(() => {
        if (ready && !authenticated) setOpen(false);
    }, [ready, authenticated, setOpen]);

    const account = useAccount();
    // The wallet's own USDC, which a deposit draws on.
    // Read again whenever a deposit moves on, so Max doesn't offer what has already been sent.
    const walletBalance = useUsdcBalance(user ? depositWalletAddress(user, active) : undefined, open, account.notice);
    const evmNetwork = useWalletNetwork(address);
    const network = active.kind === "solana" ? "solana" : evmNetwork;

    // Mock positions until trading is live.
    const [positions, setPositions] = useState(MOCK_POSITIONS);

    // Remount the animated parts on every open so they replay their entrance.
    const [openings, setOpenings] = useState(0);
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) setOpenings((n) => n + 1);
    }

    if (!ready || !authenticated) return null;

    const closePosition = (id: string) => {
        setPositions((list) => list.filter((p) => p.id !== id));
    };

    return (
        <MotionConfig reducedMotion="user">
            <header className={styles.header}>
                {address && (
                    <span className={styles.account}>
                        <NetworkLogo network={network} className={styles.networkLogo} />
                        {shortenAddress(address)}
                    </span>
                )}
                <IconButton label="Connect another wallet" onClick={() => linkOther(otherKind)}>
                    <PlusIcon />
                </IconButton>
                <IconButton label="Disconnect" onClick={() => logout()}>
                    <PowerIcon />
                </IconButton>
                <IconButton label="Close sidebar" onClick={() => setOpen(false)}>
                    <CloseIcon />
                </IconButton>
            </header>

            <WalletSection
                key={`wallet-${openings}`}
                balance={account.balance}
                walletBalance={walletBalance}
                history={account.history}
                minDeposit={account.state.status === "ready" ? Number(account.state.rules.minDeposit) : null}
                accountProblem={account.state.status === "failed" ? account.state.error.message : null}
                notice={account.notice}
                onDeposit={account.deposit}
                onDepositCoin={account.depositCoin}
                quote={account.quote}
                orders={account.orders}
                onStartDeposit={account.dismissNotice}
                balances={account.balances}
                wallets={linked}
                onOpenCoins={account.refreshBalances}
                onPick={(row) => {
                    const wallet = linked.find((w) => sameAddress(w.address, row.wallet));
                    if (wallet) active.setActive(wallet);
                }}
                onConnect={(kind) => {
                    linkOther(kind);
                    account.refreshBalances();
                }}
            />

            <div className={styles.positionsFrame}>
                <div ref={trackScrollEdges} className={styles.positionsScroller}>
                    <motion.ul
                        key={`positions-${openings}`}
                        className={styles.positions}
                        aria-label="Open positions"
                        initial="hidden"
                        animate={open ? "shown" : "hidden"}
                    >
                        <AnimatePresence mode="popLayout">
                            {positions.map((position, i) => (
                                <PositionRow
                                    key={position.id}
                                    position={position}
                                    entranceDelay={entranceDelay(i, positions.length)}
                                    onClose={closePosition}
                                />
                            ))}
                        </AnimatePresence>
                    </motion.ul>
                    <AnimatePresence>
                        {positions.length === 0 && (
                            <motion.p
                                className={styles.empty}
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0, transition: { ...settle, delay: 0.25 } }}
                                exit={{ opacity: 0 }}
                            >
                                No open positions
                            </motion.p>
                        )}
                    </AnimatePresence>
                </div>
                <ScrollEdges />
            </div>
        </MotionConfig>
    );
}

type WalletSectionProps = {
    /** The account's USDC, deposits on their way included; undefined while loading and null when it couldn't be read. */
    balance: number | null | undefined;
    /** The wallet's own USDC on Arc, likewise. */
    walletBalance: number | null | undefined;
    history: HistoryRow[];
    /** Null until the account has loaded, and deposits can't start before then. */
    minDeposit: number | null;
    /** Why the account couldn't be loaded. */
    accountProblem: string | null;
    notice: DepositNotice | null;
    onDeposit: (amount: string) => Promise<DepositResult>;
    /** Bridges `amount` of a coin on another chain into the account. */
    onDepositCoin: (coin: string, amount: string, wallet: string) => Promise<DepositResult>;
    quote: (coin: string, amount: string, wallet: string) => Promise<DepositQuoteView | ApiError>;
    /** Bridge orders still open, newest first. */
    orders: DepositOrderView[];
    onStartDeposit: () => void;
    /** Every coin in every linked wallet; null before any read. */
    balances: CoinBalance[] | null;
    wallets: Wallet[];
    /** Deposit was clicked: read the balances again, silently. */
    onOpenCoins: () => void;
    /** A coin row was picked: its wallet becomes the one to deposit from. */
    onPick: (row: CoinBalance) => void;
    onConnect: (kind: Wallet["kind"]) => void;
};

/** Balance and the deposit button; hovering it deals out past deposits. */
function WalletSection({
    balance,
    walletBalance,
    history,
    minDeposit,
    accountProblem,
    notice,
    onDeposit,
    onDepositCoin,
    quote,
    orders,
    onStartDeposit,
    balances,
    wallets,
    onOpenCoins,
    onPick,
    onConnect,
}: WalletSectionProps) {
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [pinned, setPinned] = useState(false);
    // Deposit opens the coin list; picking a coin opens the amount field.
    const [stage, setStage] = useState<"closed" | "coins" | "amount">("closed");
    // The coin row picked, whose wallet the deposit is sent from.
    const [picked, setPicked] = useState<CoinBalance | null>(null);
    // The form closed: the Deposit button that takes its place gets focus.
    const [refocus, setRefocus] = useState(false);
    const section = useRef<HTMLElement>(null);
    useEffect(() => {
        if (!refocus || stage !== "closed") return;
        setRefocus(false);
        section.current?.querySelector<HTMLElement>("button[data-phase]")?.focus();
    }, [refocus, stage]);
    const depositing = stage === "amount" && minDeposit !== null && picked !== null;
    const choosing = stage === "coins" && minDeposit !== null;
    // The history would cover the positions while a coin or an amount is chosen.
    const showHistory = (hovered || focused || pinned) && !depositing && !choosing;
    const status = notice ? null : accountProblem;

    // A bridged deposit's progress, until it has ended for a while or the next deposit starts.
    const [dismissed, setDismissed] = useState<string | null>(null);
    const [since] = useState(() => Date.now() - ENDED_VISIBLE_MS);
    const order = notice ? null : shownOrder(orders, dismissed, since);
    const endedId = order && !isRunning(order) ? order.id : null;
    useEffect(() => {
        if (!endedId) return;
        const timer = setTimeout(() => setDismissed(endedId), ENDED_VISIBLE_MS);
        return () => clearTimeout(timer);
    }, [endedId]);
    // The row as the latest read has it, so a deposit just sent shows in what's left.
    const coin =
        picked && (balances?.find((r) => r.coin === picked.coin && sameAddress(r.wallet, picked.wallet)) ?? picked);

    return (
        <section
            ref={section}
            className={styles.wallet}
            aria-label="Balance"
            data-history={showHistory || choosing ? "open" : "closed"}
            onPointerEnter={(event) => canHover(event) && setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            // Keyboard focus only: a tap also focuses, and would pin it open.
            onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
            }}
        >
            {/* Touch has no hover: tapping the balance pins the history open. */}
            <button
                type="button"
                className={styles.balanceButton}
                aria-expanded={showHistory}
                aria-label={`Balance ${balanceLabel(balance)}, show deposits`}
                onPointerUp={(event) => !canHover(event) && setPinned((p) => !p)}
            >
                {balance == null ? (
                    <span className={`${styles.balance} ${styles.balancePending}`}>—</span>
                ) : (
                    <Balance value={balance} />
                )}
            </button>

            {depositing ? (
                <DepositForm
                    coin={coin!}
                    walletBalance={walletBalance}
                    minDeposit={minDeposit}
                    onSubmit={coin!.coin === "arc:USDC" ? onDeposit : (amount) => onDepositCoin(coin!.coin, amount, coin!.wallet)}
                    preview={coin!.coin === "arc:USDC" ? undefined : (amount) => quote(coin!.coin, amount, coin!.wallet)}
                    onClose={() => {
                        setStage("closed");
                        setRefocus(true);
                    }}
                />
            ) : (
                // Not `disabled` while the account loads, which would drop keyboard focus.
                <DepositButton
                    notice={notice}
                    order={order}
                    disabled={minDeposit === null}
                    onClick={() => {
                        if (minDeposit === null) return;
                        if (endedId) setDismissed(endedId);
                        onStartDeposit();
                        onOpenCoins();
                        setStage("coins");
                    }}
                />
            )}

            {/* Always mounted, so screen readers announce what appears in it. */}
            {order ? (
                <DepositProgress order={order} />
            ) : (
                <p role="status" className={styles.status} data-tone={statusTone(notice, status)}>
                    {status ?? (notice && <NoticeText notice={notice} />)}
                </p>
            )}

            {/* Floats over the positions instead of pushing them down. */}
            <AnimatePresence>
                {choosing && (
                    <DepositCoins
                        key="coins"
                        rows={balances}
                        wallets={wallets}
                        onPick={(row) => {
                            onPick(row);
                            setPicked(row);
                            setStage("amount");
                        }}
                        onConnect={onConnect}
                        onClose={() => setStage("closed")}
                    />
                )}
            </AnimatePresence>
            <AnimatePresence>
                {showHistory && history.length > 0 && (
                    <motion.div
                        key="history"
                        className={styles.historyFrame}
                        initial="hidden"
                        animate="shown"
                        exit="hidden"
                    >
                        <ol ref={historyRef} className={styles.history} aria-label="Deposits">
                            <AnimatePresence>
                                {history.map((row, i) => (
                                    <motion.li
                                        key={row.key}
                                        layout
                                        custom={i}
                                        variants={depositRow}
                                        className={styles.depositRow}
                                        data-pending={row.pending || undefined}
                                        style={{ zIndex: history.length - i }}
                                    >
                                        <CoinIcon
                                            symbol={row.origin ? row.origin.coin.split(":")[1]! : "USDC"}
                                            className={styles.depositCoin}
                                        />
                                        <span className={styles.depositAmount}>
                                            +{formatUsd(toUsdc(row.amount))}
                                            {row.origin && (
                                                <span className={styles.depositOrigin}>
                                                    {" · "}
                                                    {row.origin.amount} {coinLabel(row.origin.coin)}
                                                </span>
                                            )}
                                        </span>
                                        {row.pending ? (
                                            <span className={`${styles.depositWhen} ${styles.depositPending}`}>
                                                <span className={styles.pendingDot} aria-hidden="true" />
                                                Pending
                                            </span>
                                        ) : (
                                            <span className={styles.depositWhen}>{formatWhen(row.at)}</span>
                                        )}
                                    </motion.li>
                                ))}
                            </AnimatePresence>
                        </ol>
                        <ScrollEdges />
                    </motion.div>
                )}
            </AnimatePresence>
        </section>
    );
}

function statusTone(notice: DepositNotice | null, problem: string | null) {
    if (problem) return undefined;
    if (notice?.kind === "credited") return "gain";
    if (notice?.kind === "reverted") return "loss";
    return undefined;
}

function NoticeText({ notice }: { notice: DepositNotice }) {
    switch (notice.kind) {
        case "confirming":
            return (
                <>
                    <span className={styles.pendingDot} aria-hidden="true" />
                    Depositing {formatUsd(toUsdc(notice.amount))}…
                </>
            );
        case "credited":
            return <>Deposited {formatUsd(toUsdc(notice.amount))}</>;
        case "reverted":
            return <>{notice.message}</>;
    }
}

function balanceLabel(balance: number | null | undefined) {
    if (balance === undefined) return "loading";
    if (balance === null) return "unavailable";
    return formatUsd(balance);
}

/** Blurred overlays for the scroll container just before them; they show
    where `trackScrollEdges` marks content hidden past an edge. They sit
    outside the scroller so the blur reads the finished, scrolled picture. */
function ScrollEdges() {
    return (
        <>
            <span className={`${styles.edge} ${styles.edgeTop}`} data-edge="top" aria-hidden="true" />
            <span className={`${styles.edge} ${styles.edgeBottom}`} data-edge="bottom" aria-hidden="true" />
        </>
    );
}

/** Counts up from zero on mount, then glides to each new value. A tween
    rather than a spring: a spring's long tail leaves the cents ticking. */
function Balance({ value }: { value: number }) {
    const amount = useMotionValue(0);
    const reduceMotion = useReducedMotion();

    useEffect(() => {
        if (reduceMotion) return amount.set(value);
        const controls = animate(amount, value, { duration: 1.1, ease: [0.16, 1, 0.3, 1] });
        return () => controls.stop();
    }, [amount, value, reduceMotion]);

    const whole = useTransform(amount, (v) => formatUsd(v).slice(0, -3));
    const cents = useTransform(amount, (v) => formatUsd(v).slice(-3));

    return (
        <span className={styles.balance}>
            <motion.span>{whole}</motion.span>
            <motion.span className={styles.cents}>{cents}</motion.span>
        </span>
    );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
    return (
        <motion.button
            type="button"
            className={styles.iconButton}
            aria-label={label}
            title={label}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.9 }}
            transition={spring}
            onClick={onClick}
        >
            {children}
        </motion.button>
    );
}
