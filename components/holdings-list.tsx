"use client";

import { useState, type FormEvent } from "react";
import { motion, type Transition } from "motion/react";
import {
    holdingRows,
    recentSends,
    sendAddress,
    sendDecimals,
    sendIssue,
    validAddress,
    type HoldingRow,
} from "@/lib/account/holdings";
import { formatUnits } from "@/lib/trade/format";
import { networkName, type NetworkId } from "@/lib/trade/networks";
import type { CoinWithdrawRequest, CoinWithdrawalView, HoldingView } from "@/server/src/trading/types";
import { CoinIcon } from "./coin-icons";
import { cleanAmount, normalizeAmount } from "./deposit-form";
import { ChevronIcon } from "./icons";
import { canHover } from "./pointer";
import { formatUsd, shortenAddress } from "./wallet-data";
import styles from "./wallet-sidebar.module.css";

type HoldingsListProps = {
    holdings: HoldingView[];
    /** A coin's live price in dollars, or null before it is known. */
    priceOf: (symbol: string) => number | null;
    /** The person's linked wallets, which a coin is sent to unless they type another address. */
    wallets: { evm?: string; solana?: string };
    withdrawals: CoinWithdrawalView[];
    onSend: (req: CoinWithdrawRequest) => { requestId: string; sent: boolean; message?: string };
};

/** Shown only when the account gave no reason for a send it didn't start. */
const NOT_SENT = "The send wasn't started, so nothing was sent.";
const SEND_STATE = { sending: "Sending", sent: "Sent", failed: "Couldn't send" } as const;

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };
const reveal: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.2 };

/** The coins the account holds, each with a Send that moves it to the person's own wallet, and the sends' progress below. */
export function HoldingsList({ holdings, priceOf, wallets, withdrawals, onSend }: HoldingsListProps) {
    const [sending, setSending] = useState<string | null>(null);
    const rows = holdingRows(holdings, priceOf);
    // A render-time clock would not prerender; the sends list is only ever filled on the client.
    const [now] = useState(() => Date.now());
    const sends = recentSends(withdrawals, now);
    if (rows.length === 0 && sends.length === 0) return null;

    return (
        <section aria-label="Holdings" className="flex shrink-0 flex-col gap-2 pb-2">
            <ul className="flex flex-col gap-2">
                {rows.map((row) => (
                    <li key={row.symbol} className="flex flex-col gap-2">
                        <HoldingCard
                            row={row}
                            open={sending === row.symbol}
                            onToggle={() => setSending((open) => (open === row.symbol ? null : row.symbol))}
                        />
                        {sending === row.symbol && (
                            <SendForm
                                row={row}
                                prefill={sendAddress(row.network, wallets)}
                                onClose={() => setSending(null)}
                                onSend={(req) => {
                                    const result = onSend(req);
                                    if (result.sent) setSending(null);
                                    // null once sent, else why it wasn't
                                    return result.sent ? null : (result.message ?? NOT_SENT);
                                }}
                            />
                        )}
                    </li>
                ))}
            </ul>
            {sends.length > 0 && (
                <ul aria-label="Sends" className="flex flex-col gap-1 px-2">
                    {sends.map((send) => (
                        <li
                            key={send.id}
                            className={`text-[13px] leading-snug ${send.state === "failed" ? "text-loss" : "text-muted"}`}
                        >
                            {SEND_STATE[send.state]} {formatUnits(Number(send.units), send.symbol)} to{" "}
                            {shortenAddress(send.to)}
                            {send.state === "failed"
                                ? `. ${send.message ?? "It's back in your holdings."}`
                                : send.state === "sending" && send.message
                                  ? `. ${send.message}`
                                  : ""}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/**
 * One coin: its amount and worth. Send slides in on hover (or focus, or a tap on touch), as Close does on a
 * position, and stays while the form is open, as a chevron that folds it away.
 */
function HoldingCard({ row, open, onToggle }: { row: HoldingRow; open: boolean; onToggle: () => void }) {
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [tapped, setTapped] = useState(false);
    const revealed = open || hovered || focused || tapped;
    return (
        <div
            className="flex min-h-14 items-center gap-3 rounded-[22px] bg-pill px-[10px] py-2"
            onPointerEnter={(event) => canHover(event) && setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onPointerUp={(event) => !canHover(event) && setTapped((t) => !t)}
            // Keyboard focus only: a tap also focuses, and would pin it open.
            onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
            }}
        >
            <CoinIcon symbol={row.symbol} className="size-9" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-base font-medium tracking-[-0.02em]">
                    {formatUnits(Number(row.units), row.symbol)}
                </span>
                <span className="text-[13px] text-muted tabular-nums">
                    {row.usd === null ? "—" : formatUsd(row.usd)}
                </span>
            </div>
            {/* Always mounted, only collapsed, so keyboard users can tab to it. */}
            <motion.span
                className="flex shrink-0 justify-end overflow-hidden"
                initial={false}
                animate={revealed ? { width: "auto", opacity: 1 } : { width: 0, opacity: 0 }}
                transition={reveal}
            >
                <motion.button
                    type="button"
                    aria-expanded={open}
                    aria-label={open ? `Close sending ${row.symbol}` : `Send ${row.symbol}`}
                    className={`grid h-9 min-w-9 cursor-pointer place-items-center rounded-full bg-pill-hover text-sm font-medium text-foreground outline-2 outline-transparent transition-colors hover:bg-white/15 focus-visible:outline-solid ${
                        open ? "px-0" : "px-4"
                    }`}
                    initial={false}
                    animate={revealed ? { scale: 1, x: 0 } : { scale: 0.6, x: 12 }}
                    whileTap={{ scale: 0.9 }}
                    transition={spring}
                    onClick={onToggle}
                >
                    {open ? <ChevronIcon className="size-4 rotate-180" /> : "Send"}
                </motion.button>
            </motion.span>
        </div>
    );
}

/**
 * The amount and the address for one coin, laid out as the deposit and withdraw forms are: the amount with its
 * coin and Max inside the field, then the address beside Send. The address starts as the linked wallet on the
 * coin's network.
 */
function SendForm({
    row,
    prefill,
    onSend,
    onClose,
}: {
    row: HoldingRow;
    prefill: string;
    onSend: (req: CoinWithdrawRequest) => string | null;
    onClose: () => void;
}) {
    const [amount, setAmount] = useState("");
    const [to, setTo] = useState(prefill);
    const [problem, setProblem] = useState<string | null>(null);
    const network = row.network as NetworkId;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const units = normalizeAmount(amount) ?? "";
        const issue = sendIssue(units, row.units) ?? (validAddress(row.network, to) ? null : "Enter a valid address.");
        setProblem(issue);
        if (issue) return;
        const refused = onSend({ requestId: crypto.randomUUID(), symbol: row.symbol, units, to });
        if (refused) setProblem(refused);
    };

    return (
        <motion.form
            className="flex origin-top flex-col gap-2 pb-1"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={spring}
            onSubmit={submit}
            noValidate
            // Escape closes only the form, not the sidebar.
            onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                onClose();
            }}
        >
            {/* Each field sits in a row, as in the deposit form, so it keeps its height. */}
            <div className={styles.depositForm}>
                <label className={styles.amountField} data-invalid={problem !== null || undefined}>
                    <input
                        className={styles.amountInput}
                        inputMode="decimal"
                        autoComplete="off"
                        // The form only opens on request, so the amount is what comes next.
                        autoFocus
                        aria-label={`Amount of ${row.symbol} to send`}
                        placeholder="0.00"
                        value={amount}
                        onChange={(event) => {
                            setAmount(cleanAmount(event.target.value, sendDecimals(row.symbol)));
                            setProblem(null);
                        }}
                    />
                    <span className={styles.amountUnit} aria-hidden="true">
                        {row.symbol}
                    </span>
                    <button type="button" className={styles.maxButton} onClick={() => setAmount(row.units)}>
                        Max
                    </button>
                </label>
            </div>
            <div className={styles.depositForm}>
                <label className={styles.amountField}>
                    <input
                        className={`${styles.amountInput} ${styles.addressInput}`}
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={`Address on ${networkName(network)}`}
                        placeholder={`Address on ${networkName(network)}`}
                        value={to}
                        onChange={(event) => {
                            setTo(event.target.value.trim());
                            setProblem(null);
                        }}
                    />
                </label>
                <motion.button
                    type="submit"
                    className={`${styles.deposit} ${styles.confirmDeposit}`}
                    aria-label={`Send ${row.symbol}`}
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.94 }}
                    transition={spring}
                >
                    Send
                </motion.button>
            </div>
            {problem && (
                <p role="alert" className={styles.depositHint} data-tone="error">
                    {problem}
                </p>
            )}
        </motion.form>
    );
}
