import { useEffect, useState } from "react";
import { useWallets } from "@privy-io/react-auth";
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
