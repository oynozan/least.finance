import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useLinkAccount, usePrivy, useWallets } from "@privy-io/react-auth";
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
    const wallet =
        (address ? wallets.find((w) => w.address.toLowerCase() === address.toLowerCase()) : undefined) ?? wallets[0];
    return wallet ? chainIdOf(wallet.chainId) : undefined;
}

export type Wallet = { kind: "evm" | "solana"; address: string };

const storageKey = (userId: string) => `active-wallet:${userId}`;
const watchers = new Set<() => void>();

const subscribe = (notify: () => void) => {
    watchers.add(notify);
    window.addEventListener("storage", notify);
    return () => {
        watchers.delete(notify);
        window.removeEventListener("storage", notify);
    };
};

const readStored = (userId: string) => {
    try {
        return localStorage.getItem(storageKey(userId));
    } catch {
        return null;
    }
};

/** An Ethereum address matches whatever its casing; a Solana one is case-sensitive. */
const sameWallet = (a: Wallet, b: Wallet) =>
    a.kind === b.kind &&
    (a.kind === "evm" ? a.address.toLowerCase() === b.address.toLowerCase() : a.address === b.address);

/** The wallets linked to this person, in the order Privy lists them. */
export function linkedWallets(user: NonNullable<ReturnType<typeof usePrivy>["user"]>): Wallet[] {
    return user.linkedAccounts.flatMap((account) =>
        account.type === "wallet" && (account.chainType === "ethereum" || account.chainType === "solana")
            ? [
                  {
                      kind: account.chainType === "solana" ? ("solana" as const) : ("evm" as const),
                      address: account.address,
                  },
              ]
            : [],
    );
}

/** The wallet this person is using: the one they chose last if it's still linked, else their first verified wallet. */
export function useActiveWallet(): Partial<Wallet> & { setActive: (wallet: Wallet) => void } {
    const { user } = usePrivy();
    const userId = user?.id;
    const stored = useSyncExternalStore(
        subscribe,
        () => (userId ? readStored(userId) : null),
        () => null,
    );
    const setActive = useCallback(
        (wallet: Wallet) => {
            if (!userId) return;
            try {
                localStorage.setItem(storageKey(userId), JSON.stringify(wallet));
            } catch {
                // No storage: the choice isn't kept.
            }
            watchers.forEach((notify) => notify());
        },
        [userId],
    );

    if (!user) return { setActive };
    let choice: Wallet | undefined;
    try {
        choice = stored ? (JSON.parse(stored) as Wallet) : undefined;
    } catch {
        // A value that isn't ours: fall back to the first wallet.
    }
    const match = choice && linkedWallets(user).find((wallet) => sameWallet(wallet, choice));
    if (match) return { ...match, setActive };
    if (!user.wallet) return { setActive };
    return { kind: user.wallet.chainType === "solana" ? "solana" : "evm", address: user.wallet.address, setActive };
}

/** Opens Privy's flow to link a wallet of this kind, and makes it the active one once it's linked. */
export function useLinkOtherWallet(): (kind: "evm" | "solana") => void {
    const { setActive } = useActiveWallet();
    const { linkWallet } = useLinkAccount({
        onSuccess: ({ linkedAccount }) => {
            if (linkedAccount.type !== "wallet") return;
            if (linkedAccount.chainType !== "ethereum" && linkedAccount.chainType !== "solana") return;
            setActive({
                kind: linkedAccount.chainType === "solana" ? "solana" : "evm",
                address: linkedAccount.address,
            });
        },
    });
    return (kind) => linkWallet({ walletChainType: kind === "evm" ? "ethereum-only" : "solana-only" });
}
