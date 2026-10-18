"use client";

import { useEffect, useState } from "react";
import { useLogin, usePrivy } from "@privy-io/react-auth";
import { motion, type Transition } from "motion/react";
import { loginProblem, PRIVY_NOT_LOADING, PRIVY_READY_MS } from "@/lib/wallet/login-errors";
import { useActiveWallet } from "./arc-wallet";
import { Magnet } from "./magnet";
import { SIDEBAR_ID, useSidebar } from "./sidebar";
import { shortenAddress } from "./wallet-data";
import { walletEnabled } from "./wallet-provider";
import styles from "./connect-wallet.module.css";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.45 };

/** Pinned to the top of every page, outside its centered flow. */
export function ConnectWallet() {
    return (
        // Hover cards keep clear of it
        <div className={styles.top} data-keep-clear="">
            <Magnet padding={30} magnetStrength={4}>
                {walletEnabled ? (
                    <PrivyWalletButton />
                ) : (
                    <WalletButton
                        label="Connect wallet"
                        title="Set NEXT_PUBLIC_PRIVY_APP_ID in .env.local to enable"
                        disabled
                    />
                )}
            </Magnet>
        </div>
    );
}

function PrivyWalletButton() {
    const { ready, authenticated } = usePrivy();
    const { open, setOpen, toggle } = useSidebar();
    // A fresh connection opens the sidebar straight away.
    const [problem, setProblem] = useState<string | null>(null);
    const { login } = useLogin({
        onComplete: ({ wasAlreadyAuthenticated }) => {
            setProblem(null);
            if (!wasAlreadyAuthenticated) setOpen(true);
        },
        onError: (code) => {
            console.warn("Privy sign-in failed:", code);
            setProblem(loginProblem(String(code)));
        },
    });
    const address = useActiveWallet().address;
    // A sign-in service that never becomes ready leaves the button disabled; say why after a while
    const [slow, setSlow] = useState(false);
    useEffect(() => {
        if (ready) return;
        const timer = setTimeout(() => setSlow(true), PRIVY_READY_MS);
        return () => clearTimeout(timer);
    }, [ready]);
    const shownProblem = problem ?? (!ready && slow ? PRIVY_NOT_LOADING : null);

    if (ready && authenticated) {
        return (
            <WalletButton
                label={address ? shortenAddress(address) : "Connected"}
                aria-label={address ? `Wallet ${address}` : "Wallet"}
                aria-expanded={open}
                aria-controls={SIDEBAR_ID}
                connected
                onClick={toggle}
            />
        );
    }

    return (
        <>
            <WalletButton
                label="Connect wallet"
                disabled={!ready}
                onClick={() => {
                    setProblem(null);
                    login({ loginMethods: ["wallet"] });
                }}
            />
            {shownProblem && (
                <p role="status" className={styles.problem}>
                    {shownProblem}
                </p>
            )}
        </>
    );
}

type WalletButtonProps = {
    label: string;
    connected?: boolean;
    disabled?: boolean;
    title?: string;
    "aria-label"?: string;
    "aria-expanded"?: boolean;
    "aria-controls"?: string;
    onClick?: () => void;
};

function WalletButton({ label, connected, disabled, onClick, ...rest }: WalletButtonProps) {
    return (
        <motion.button
            type="button"
            className={styles.button}
            disabled={disabled}
            onClick={onClick}
            whileHover={disabled ? undefined : { scale: 1.05 }}
            whileTap={disabled ? undefined : { scale: 0.92 }}
            transition={spring}
            {...rest}
        >
            {connected && <span className={styles.dot} aria-hidden="true" />}
            {label}
        </motion.button>
    );
}
