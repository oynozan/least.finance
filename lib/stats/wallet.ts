import type { StatsWallet } from "@/server/src/protocol";

/** What the server says of a wallet it has no address for. */
export const NOT_SET_UP = "Not set up";

/** A wallet that isn't set up reads muted; any other read error is a problem to show in red. */
export function walletState(wallet: Pick<StatsWallet, "error">): { notSetUp: boolean; problem: string | null } {
    const notSetUp = wallet.error === NOT_SET_UP;
    return { notSetUp, problem: wallet.error && !notSetUp ? wallet.error : null };
}
