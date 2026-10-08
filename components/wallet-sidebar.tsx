"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePrivy } from "@privy-io/react-auth";
import {
  AnimatePresence,
  MotionConfig,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type Transition,
  type Variants,
} from "motion/react";
import { CoinIcon } from "./coin-icons";
import { CloseIcon, PlusIcon, PowerIcon } from "./icons";
import { canHover } from "./pointer";
import { PositionRow } from "./position-row";
import { useSidebar } from "./sidebar";
import {
  MOCK_BALANCE,
  MOCK_DEPOSITS,
  MOCK_POSITIONS,
  formatUsd,
  formatWhen,
  shortenAddress,
  type Deposit,
} from "./wallet-data";
import { walletEnabled } from "./wallet-provider";
import styles from "./wallet-sidebar.module.css";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };
const settle: Transition = { type: "spring", visualDuration: 0.4, bounce: 0.15 };

const positionList: Variants = {
  hidden: {},
  // Delayed so rows rise once the panel has mostly arrived.
  shown: { transition: { staggerChildren: 0.05, delayChildren: 0.18 } },
};

const depositList: Variants = {
  hidden: { transition: { staggerChildren: 0.03, staggerDirection: -1 } },
  shown: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
};

// Collapsed, every deposit hides up under the one above it, a little
// smaller each step back; revealing deals them out into a list.
const depositRow: Variants = {
  hidden: (i: number) => ({
    opacity: 0,
    y: -18 * (i + 1),
    scale: 1 - 0.05 * (i + 1),
    filter: "blur(4px)",
    transition: { duration: 0.16, ease: "easeIn" },
  }),
  shown: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)", transition: spring },
};

/** The sidebar's content. Renders nothing until a wallet is signed in. */
export function WalletSidebar() {
  if (!walletEnabled) return null;
  return <SignedInWallet />;
}

function SignedInWallet() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { open, setOpen } = useSidebar();
  const address = user?.wallet?.address;

  // Signing out from anywhere also folds the sidebar away.
  useEffect(() => {
    if (ready && !authenticated) setOpen(false);
  }, [ready, authenticated, setOpen]);

  // Mock state until positions and deposits come from the backend.
  const [balance, setBalance] = useState(MOCK_BALANCE);
  const [deposits, setDeposits] = useState(MOCK_DEPOSITS);
  const [positions, setPositions] = useState(MOCK_POSITIONS);

  // Remount the animated parts on every open so they replay their entrance.
  const [openings, setOpenings] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpenings((n) => n + 1);
  }

  if (!ready || !authenticated) return null;

  const deposit = () => {
    const entry: Deposit = { id: `d-${Date.now()}`, symbol: "USDC", amount: 500, at: new Date() };
    setDeposits((list) => [entry, ...list]);
    setBalance((b) => b + entry.amount);
  };

  const closePosition = (id: string) => {
    const closed = positions.find((p) => p.id === id);
    if (!closed) return;
    setPositions((list) => list.filter((p) => p.id !== id));
    setBalance((b) => b + closed.size + closed.pnl);
  };

  return (
    <MotionConfig reducedMotion="user">
      <header className={styles.header}>
        {address && (
          <span className={styles.account}>
            <span className={styles.avatar} style={avatarStyle(address)} aria-hidden="true" />
            {shortenAddress(address)}
          </span>
        )}
        <IconButton label="Disconnect" onClick={() => logout()}>
          <PowerIcon />
        </IconButton>
        <IconButton label="Close sidebar" onClick={() => setOpen(false)}>
          <CloseIcon />
        </IconButton>
      </header>

      <WalletSection
        key={`wallet-${openings}`}
        balance={balance}
        deposits={deposits}
        onDeposit={deposit}
      />

      <div className={styles.positionsScroller}>
        <motion.ul
          key={`positions-${openings}`}
          className={styles.positions}
          aria-label="Open positions"
          variants={positionList}
          initial="hidden"
          animate={open ? "shown" : "hidden"}
        >
          <AnimatePresence mode="popLayout">
            {positions.map((position) => (
              <PositionRow key={position.id} position={position} onClose={closePosition} />
            ))}
          </AnimatePresence>
        </motion.ul>
        <AnimatePresence>
          {positions.length === 0 && (
            <motion.p
              className={styles.empty}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: { ...settle, delay: 0.25 } }}
              exit={{ opacity: 0 }}
            >
              No open positions
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}

type WalletSectionProps = {
  balance: number;
  deposits: Deposit[];
  onDeposit: () => void;
};

/** Balance and the deposit button; hovering it deals out past deposits. */
function WalletSection({ balance, deposits, onDeposit }: WalletSectionProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const showHistory = hovered || focused || pinned;

  return (
    <section
      className={styles.wallet}
      aria-label="Balance"
      data-history={showHistory ? "open" : "closed"}
      onPointerEnter={(event) => canHover(event) && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      // Keyboard focus only: a tap also focuses, and would pin it open.
      onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      {/* Touch has no hover: tapping the balance pins the history open. */}
      <button
        type="button"
        className={styles.balanceButton}
        aria-expanded={showHistory}
        aria-label={`Balance ${formatUsd(balance)}, show deposits`}
        onPointerUp={(event) => !canHover(event) && setPinned((p) => !p)}
      >
        <Balance value={balance} />
      </button>

      <motion.button
        type="button"
        className={styles.deposit}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.94 }}
        transition={spring}
        onClick={onDeposit}
      >
        <PlusIcon className={styles.depositIcon} />
        Deposit
      </motion.button>

      {/* Floats over the positions instead of pushing them down. */}
      <AnimatePresence>
        {showHistory && deposits.length > 0 && (
          <motion.ol
            key="history"
            className={styles.history}
            aria-label="Deposits"
            variants={depositList}
            initial="hidden"
            animate="shown"
            exit="hidden"
          >
            <AnimatePresence initial={false}>
              {deposits.map((deposit, i) => (
                <motion.li
                  key={deposit.id}
                  layout
                  custom={i}
                  variants={depositRow}
                  className={styles.depositRow}
                  style={{ zIndex: deposits.length - i }}
                >
                  <CoinIcon symbol={deposit.symbol} className={styles.depositCoin} />
                  <span className={styles.depositAmount}>+{formatUsd(deposit.amount)}</span>
                  <span className={styles.depositWhen}>{formatWhen(deposit.at)}</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ol>
        )}
      </AnimatePresence>
    </section>
  );
}

/** Counts up from zero on mount, then glides to each new value. A tween
    rather than a spring: a spring's long tail leaves the cents ticking. */
function Balance({ value }: { value: number }) {
  const amount = useMotionValue(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) return amount.set(value);
    const controls = animate(amount, value, { duration: 1.1, ease: [0.16, 1, 0.3, 1] });
    return () => controls.stop();
  }, [amount, value, reduceMotion]);

  const whole = useTransform(amount, (v) => formatUsd(v).slice(0, -3));
  const cents = useTransform(amount, (v) => formatUsd(v).slice(-3));

  return (
    <span className={styles.balance}>
      <motion.span>{whole}</motion.span>
      <motion.span className={styles.cents}>{cents}</motion.span>
    </span>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <motion.button
      type="button"
      className={styles.iconButton}
      aria-label={label}
      title={label}
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.9 }}
      transition={spring}
      onClick={onClick}
    >
      {children}
    </motion.button>
  );
}

/** A two-tone gradient seeded by the address, as a tiny identicon. */
function avatarStyle(address: string) {
  const seed = parseInt(address.slice(2, 10), 16) || 0;
  const hue = seed % 360;
  return {
    background: `conic-gradient(from ${seed % 180}deg, hsl(${hue} 80% 62%), hsl(${(hue + 70) % 360} 85% 55%), hsl(${hue} 80% 62%))`,
  };
}
