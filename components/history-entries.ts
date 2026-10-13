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
};

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
    }));
    const placed = withdrawals.map((w): WithdrawalEntry => ({
        kind: "withdrawal",
        key: w.requestId,
        amount: toWei(w.amount),
        at: new Date(w.createdAt),
        to: w.to,
        state: w.state,
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
