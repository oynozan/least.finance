"use client";

import { useState, type FormEvent } from "react";
import {
    holdingRows,
    recentSends,
    sendAddress,
    sendIssue,
    validAddress,
    type HoldingRow,
} from "@/lib/account/holdings";
import { formatUnits } from "@/lib/trade/format";
import { networkName, type NetworkId } from "@/lib/trade/networks";
import type { CoinWithdrawRequest, CoinWithdrawalView, HoldingView } from "@/server/src/trading/types";
import { CoinIcon } from "./coin-icons";
import { formatUsd, shortenAddress } from "./wallet-data";

type HoldingsListProps = {
    holdings: HoldingView[];
    /** A coin's live price in dollars, or null before it is known. */
    priceOf: (symbol: string) => number | null;
    /** The person's linked wallets, which a coin is sent to unless they type another address. */
    wallets: { evm?: string; solana?: string };
    withdrawals: CoinWithdrawalView[];
    onSend: (req: CoinWithdrawRequest) => { requestId: string; sent: boolean };
};

const SEND_STATE = { sending: "Sending", sent: "Sent", failed: "Couldn't send" } as const;

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
                    <li key={row.symbol} className="flex flex-col gap-2 rounded-[22px] bg-pill px-[10px] py-2">
                        <div className="flex min-h-10 items-center gap-3">
                            <CoinIcon symbol={row.symbol} className="size-9" />
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="truncate text-base font-medium tracking-[-0.02em]">
                                    {formatUnits(Number(row.units), row.symbol)}
                                </span>
                                <span className="text-[13px] text-muted tabular-nums">
                                    {row.usd === null ? "—" : formatUsd(row.usd)}
                                </span>
                            </div>
                            <button
                                type="button"
                                aria-expanded={sending === row.symbol}
                                aria-label={`Send ${row.symbol}`}
                                className="h-9 cursor-pointer rounded-full bg-pill-hover px-4 text-sm font-medium text-foreground outline-2 outline-transparent transition-colors hover:bg-white/15 focus-visible:outline-solid"
                                onClick={() => setSending((open) => (open === row.symbol ? null : row.symbol))}
                            >
                                Send
                            </button>
                        </div>
                        {sending === row.symbol && (
                            <SendForm
                                row={row}
                                prefill={sendAddress(row.network, wallets)}
                                onSend={(req) => {
                                    const result = onSend(req);
                                    if (result.sent) setSending(null);
                                    return result.sent;
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
                            {send.state === "failed" ? ". It's back in your holdings." : ""}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/** The amount and the address for one coin; the address starts as the linked wallet on the coin's network. */
function SendForm({
    row,
    prefill,
    onSend,
}: {
    row: HoldingRow;
    prefill: string;
    onSend: (req: CoinWithdrawRequest) => boolean;
}) {
    const [amount, setAmount] = useState("");
    const [to, setTo] = useState(prefill);
    const [problem, setProblem] = useState<string | null>(null);
    const network = row.network as NetworkId;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const issue = sendIssue(amount, row.units) ?? (validAddress(row.network, to) ? null : "Enter a valid address.");
        setProblem(issue);
        if (issue) return;
        if (!onSend({ requestId: crypto.randomUUID(), symbol: row.symbol, units: amount, to })) {
            setProblem("You're offline. Nothing was sent.");
        }
    };

    const field =
        "h-10 w-full rounded-full bg-background/60 px-4 text-[15px] text-foreground outline-2 outline-transparent placeholder:text-muted focus-visible:outline-solid";
    return (
        <form className="flex flex-col gap-2 pb-1" onSubmit={submit} noValidate>
            <div className="flex gap-2">
                <input
                    className={field}
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label={`Amount of ${row.symbol} to send`}
                    placeholder={`Amount of ${row.symbol}`}
                    value={amount}
                    onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))}
                />
                <button
                    type="button"
                    className="h-10 shrink-0 cursor-pointer rounded-full bg-pill-hover px-4 text-sm font-medium"
                    onClick={() => setAmount(row.units)}
                >
                    Max
                </button>
            </div>
            <input
                className={field}
                autoComplete="off"
                spellCheck={false}
                aria-label={`Address on ${networkName(network)}`}
                placeholder={`Address on ${networkName(network)}`}
                value={to}
                onChange={(event) => setTo(event.target.value.trim())}
            />
            {problem && (
                <p role="alert" className="px-2 text-[13px] text-loss">
                    {problem}
                </p>
            )}
            <button
                type="submit"
                className="h-10 cursor-pointer rounded-full bg-gain text-[15px] font-semibold text-background"
            >
                Send {row.symbol}
            </button>
        </form>
    );
}
