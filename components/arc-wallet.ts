import { useEffect, useState } from "react";
import { useWallets } from "@privy-io/react-auth";
import { isAddress } from "viem";
import { arc, readUsdcBalance } from "./arc";

const BALANCE_POLL_MS = 15_000;

/** EIP-1193's code for a request the user turned down in their wallet. */
const USER_REJECTED = 4001;

type Reading = { owner: string; usdc: number | null };

/** The owner's USDC on Arc, undefined until the first read and null if reads fail before one lands. */
export function useUsdcBalance(owner: string | undefined, live: boolean) {
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
  }, [owner, live]);

  return reading && reading.owner === owner ? reading.usdc : undefined;
}

/** Whether the signed-in wallet sits on another network, and a way to move it to Arc. */
export function useArcNetwork(address: string | undefined) {
  const { wallets } = useWallets();
  const [switching, setSwitching] = useState(false);
  const [failedOn, setFailedOn] = useState<string>();

  const signedIn = address
    ? wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())
    : undefined;
  // After an account switch in the wallet app, its newest account still carries its network.
  const wallet = signedIn ?? wallets[0];
  const offArc = wallet !== undefined && wallet.chainId !== `eip155:${arc.id}`;

  const switchToArc = async () => {
    if (!wallet || switching) return;
    const from = wallet.chainId;
    setSwitching(true);
    setFailedOn(undefined);
    try {
      await wallet.switchChain(arc.id);
    } catch (error) {
      if ((error as { code?: unknown }).code !== USER_REJECTED) setFailedOn(from);
    } finally {
      setSwitching(false);
    }
  };

  return {
    offArc,
    switching,
    /** The wallet turned the switch down without the user declining it, so it likely can't reach Arc. */
    cantSwitch: offArc && failedOn === wallet?.chainId,
    switchToArc,
  };
}
