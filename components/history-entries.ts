import { toWei, type HistoryRow, type PendingWithdrawal } from "@/lib/account/state";
import type { WithdrawalView } from "@/server/src/protocol";

export type WithdrawalEntry = {
    kind: "withdrawal";
    key: string;
    /** Wei. */
    amount: bigint;
    at: Date;
    to: string;
    state: WithdrawalView["state"];
    /** A Solana withdrawal that has been forwarding for 15 minutes. */
    delayed: boolean;
};

/** What a withdrawal's line says in place of its age while it is under way, or null once it is sent or failed. */
export function withdrawalProgress(entry: Pick<WithdrawalEntry, "state" | "delayed">): string | null {
    if (entry.state === "sending") return "Sending";
    if (entry.state !== "forwarding") return null;
    return entry.delayed ? "Taking longer than expected" : "Sending to Solana";
}

export type DepositEntry = HistoryRow & { kind: "deposit" };

/** One line of the sidebar's history: a deposit or a withdrawal. */
export type Entry = DepositEntry | WithdrawalEntry;

/** The withdrawals as history lines, newest first: the ones not answered yet read as sending. */
export function withdrawalEntries(withdrawals: WithdrawalView[], pending: PendingWithdrawal[]): WithdrawalEntry[] {
    const asked = pending.map((p): WithdrawalEntry => ({
        kind: "withdrawal",
        key: p.requestId,
        amount: p.amount,
        at: new Date(p.at),
        to: p.to,
        state: "sending",
        delayed: false,
    }));
    const placed = withdrawals.map((w): WithdrawalEntry => ({
        kind: "withdrawal",
        key: w.requestId,
        amount: toWei(w.amount),
        at: new Date(w.createdAt),
        to: w.to,
        state: w.state,
        delayed: w.delayed,
    }));
    return [...asked, ...placed].sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** The deposits in their order with the withdrawals slotted in by time. */
export function mergeEntries(history: HistoryRow[], withdrawals: WithdrawalEntry[]): Entry[] {
    const merged: Entry[] = [];
    let next = 0;
    for (const row of history) {
        while (next < withdrawals.length && withdrawals[next]!.at.getTime() >= row.at.getTime())
            merged.push(withdrawals[next++]!);
        merged.push({ ...row, kind: "deposit" });
    }
    return [...merged, ...withdrawals.slice(next)];
}
