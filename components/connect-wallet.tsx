"use client";

import { usePrivy } from "@privy-io/react-auth";
import { motion, type Transition } from "motion/react";
import { Magnet } from "./magnet";
import { walletEnabled } from "./wallet-provider";
import styles from "./connect-wallet.module.css";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.45 };

/** Pinned to the bottom of the page, outside the hero's centered flow. */
export function ConnectWallet() {
  return (
    <div className={styles.dock}>
      <Magnet padding={60} magnetStrength={3}>
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
  const { ready, authenticated, user, login, logout } = usePrivy();
  const address = user?.wallet?.address;

  if (ready && authenticated) {
    return (
      <WalletButton
        label={address ? shorten(address) : "Connected"}
        aria-label={address ? `Disconnect wallet ${address}` : "Disconnect wallet"}
        title="Disconnect"
        connected
        onClick={() => logout()}
      />
    );
  }

  return (
    <WalletButton
      label="Connect wallet"
      disabled={!ready}
      onClick={() => login({ loginMethods: ["wallet"] })}
    />
  );
}

type WalletButtonProps = {
  label: string;
  connected?: boolean;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
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

const shorten = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
