import { useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { isAddress } from "viem";
import { chainIdOf } from "@/lib/wallet/network";
import { readUsdcBalance } from "./arc";

const BALANCE_POLL_MS = 15_000;

type Reading = { owner: string; usdc: number | null };

/**
 * The owner's USDC on Arc, undefined until the first read and null if reads
 * fail before one lands. A change to `refresh` reads it again at once.
 */
export function useUsdcBalance(owner: string | undefined, live: boolean, refresh?: unknown) {
    const [reading, setReading] = useState<Reading>();

    useEffect(() => {
        if (!owner || !isAddress(owner) || !live) return;
        let started = 0;
        let applied = 0;
        let stopped = false;

        const read = () => {
            if (document.hidden) return;
            const id = ++started;
            const settle = (next: (last: Reading | undefined) => Reading) => {
                if (stopped || id < applied) return;
                applied = id;
                setReading(next);
            };
            readUsdcBalance(owner).then(
                (usdc) => settle(() => ({ owner, usdc })),
                // A failed poll keeps the last balance this owner had.
                () => settle((last) => (last?.owner === owner && last.usdc !== null ? last : { owner, usdc: null })),
            );
        };

        read();
        const timer = setInterval(read, BALANCE_POLL_MS);
        document.addEventListener("visibilitychange", read);
        return () => {
            stopped = true;
            clearInterval(timer);
            document.removeEventListener("visibilitychange", read);
        };
        // `refresh` isn't read inside: a new value only restarts the reads.
    }, [owner, live, refresh]);

    return reading && reading.owner === owner ? reading.usdc : undefined;
}

/** The EVM chain the signed-in wallet is on, else the newest connected wallet's; undefined with none connected here. */
export function useWalletNetwork(address: string | undefined): number | undefined {
    const { wallets } = useWallets();
    const wallet = (address ? wallets.find((w) => w.address.toLowerCase() === address.toLowerCase()) : undefined) ?? wallets[0];
    return wallet ? chainIdOf(wallet.chainId) : undefined;
}

export type ActiveWallet = { kind: "evm" | "solana"; address: string } | undefined;

/** The wallet this person is using: the one they chose last if it's still linked, else their first verified wallet. */
export function useActiveWallet(): ActiveWallet {
    const { user } = usePrivy();
    if (!user) return undefined;
    const linked = user.linkedAccounts.flatMap((account) =>
        account.type === "wallet" && (account.chainType === "ethereum" || account.chainType === "solana")
            ? [{ kind: account.chainType === "solana" ? ("solana" as const) : ("evm" as const), address: account.address }]
            : [],
    );
    try {
        const stored = JSON.parse(localStorage.getItem(`active-wallet:${user.id}`) ?? "null") as ActiveWallet | null;
        const match = linked.find((wallet) => wallet.kind === stored?.kind && wallet.address === stored.address);
        if (match) return match;
    } catch {
        // No storage, or a value that isn't ours: fall back to the first wallet.
    }
    if (!user.wallet) return undefined;
    return { kind: user.wallet.chainType === "solana" ? "solana" : "evm", address: user.wallet.address };
}
