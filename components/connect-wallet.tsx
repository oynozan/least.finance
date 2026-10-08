"use client";

import { useLogin, usePrivy } from "@privy-io/react-auth";
import { motion, type Transition } from "motion/react";
import { useArcNetwork } from "./arc-wallet";
import { Magnet } from "./magnet";
import { ReviewButton } from "./trade/review-button";
import { useTrade } from "./trade/trade-provider";
import { SIDEBAR_ID, useSidebar } from "./sidebar";
import { shortenAddress } from "./wallet-data";
import { walletEnabled } from "./wallet-provider";
import styles from "./connect-wallet.module.css";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.45 };

/** Pinned to the bottom of the page, outside the sentence's centered flow,
    next to the button that reviews the sentence once a wallet is connected. */
export function ConnectWallet() {
  const { wallet } = useTrade();
  const canReview = wallet.status === "connected" || wallet.status === "demo";
  return (
    <div className={styles.dock}>
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
      {canReview && (
        <Magnet padding={30} magnetStrength={4}>
          <ReviewButton />
        </Magnet>
      )}
    </div>
  );
}

function PrivyWalletButton() {
  const { ready, authenticated, user } = usePrivy();
  const { open, setOpen, toggle } = useSidebar();
  // A fresh connection opens the sidebar straight away.
  const { login } = useLogin({
    onComplete: ({ wasAlreadyAuthenticated }) => {
      if (!wasAlreadyAuthenticated) setOpen(true);
    },
  });
  const address = user?.wallet?.address;
  const { offArc } = useArcNetwork(address);

  if (ready && authenticated) {
    const name = address ? `Wallet ${address}` : "Wallet";
    return (
      <WalletButton
        label={address ? shortenAddress(address) : "Connected"}
        aria-label={offArc ? `${name}, on another network` : name}
        title={offArc ? "Your wallet is on another network. Open to switch to Arc." : undefined}
        aria-expanded={open}
        aria-controls={SIDEBAR_ID}
        connected
        offArc={offArc}
        onClick={toggle}
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
  offArc?: boolean;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  onClick?: () => void;
};

function WalletButton({ label, connected, offArc, disabled, onClick, ...rest }: WalletButtonProps) {
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
      {connected && (
        <span className={offArc ? `${styles.dot} ${styles.dotOffArc}` : styles.dot} aria-hidden="true" />
      )}
      {label}
    </motion.button>
  );
}
