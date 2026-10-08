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
import { useArcNetwork, useUsdcBalance } from "./arc-wallet";
import { CoinIcon } from "./coin-icons";
import { CloseIcon, PlusIcon, PowerIcon } from "./icons";
import { canHover } from "./pointer";
import { PositionRow } from "./position-row";
import { trackScrollEdges } from "./scroll-edges";
import { useSidebar } from "./sidebar";
import {
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

// Rows rise bottom-up once the panel has mostly arrived. Only the top rows
// (the ones in view when the list overflows) take part in the stagger;
// rows further down land straight away, out of sight.
const STAGGERED_ROWS = 8;
const entranceDelay = (index: number, count: number) =>
  0.12 + Math.max(0, index - Math.max(0, count - STAGGERED_ROWS)) * 0.03;

const deal: Transition = { type: "spring", visualDuration: 0.2, bounce: 0.25 };

// Collapsed, every deposit hides up under the one above it, a little
// smaller each step back; revealing deals them out into a list. Depth and
// stagger stop growing after the first few rows, so a long history still
// reveals as quickly as a short one (and never scales a row past zero).
const depositRow: Variants = {
  hidden: (i: number) => {
    const depth = Math.min(i + 1, 4);
    return {
      opacity: 0,
      y: -18 * depth,
      scale: 1 - 0.05 * depth,
      filter: "blur(4px)",
      // Bottom rows tuck away first.
      transition: { duration: 0.12, ease: "easeIn", delay: (3 - Math.min(i, 3)) * 0.02 },
    };
  },
  shown: (i: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: { ...deal, delay: Math.min(i, 7) * 0.03 },
  }),
};

/** Caps the history at the sidebar's bottom edge, so a long one scrolls. */
function fitToPanel(list: HTMLOListElement | null) {
  const panel = list?.closest("aside");
  if (!list || !panel) return;
  const fit = () => {
    const room = panel.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
    list.style.maxHeight = `${Math.max(room, 0)}px`;
  };
  fit();
  window.addEventListener("resize", fit);
  return () => window.removeEventListener("resize", fit);
}

function historyRef(list: HTMLOListElement | null) {
  const unfit = fitToPanel(list);
  const untrack = trackScrollEdges(list);
  return () => {
    unfit?.();
    untrack?.();
  };
}

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

  const balance = useUsdcBalance(address, open);
  const { offArc, switching, cantSwitch, switchToArc } = useArcNetwork(address);

  // Mock state until positions and deposits come from the backend.
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
  };

  const closePosition = (id: string) => {
    setPositions((list) => list.filter((p) => p.id !== id));
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
        offArc={offArc}
        switching={switching}
        cantSwitch={cantSwitch}
        onSwitchToArc={switchToArc}
      />

      <div className={styles.positionsFrame}>
        <div ref={trackScrollEdges} className={styles.positionsScroller}>
          <motion.ul
            key={`positions-${openings}`}
            className={styles.positions}
            aria-label="Open positions"
            initial="hidden"
            animate={open ? "shown" : "hidden"}
          >
            <AnimatePresence mode="popLayout">
              {positions.map((position, i) => (
                <PositionRow
                  key={position.id}
                  position={position}
                  entranceDelay={entranceDelay(i, positions.length)}
                  onClose={closePosition}
                />
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
        <ScrollEdges />
      </div>
    </MotionConfig>
  );
}

type WalletSectionProps = {
  /** USDC on Arc, undefined while loading and null when it couldn't be read. */
  balance: number | null | undefined;
  deposits: Deposit[];
  onDeposit: () => void;
  /** The wallet is on another network, so the deposit button switches it to Arc instead. */
  offArc: boolean;
  switching: boolean;
  cantSwitch: boolean;
  onSwitchToArc: () => void;
};

/** Balance and the deposit button; hovering it deals out past deposits. */
function WalletSection({
  balance,
  deposits,
  onDeposit,
  offArc,
  switching,
  cantSwitch,
  onSwitchToArc,
}: WalletSectionProps) {
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
        aria-label={`Balance ${balanceLabel(balance)}, show deposits`}
        onPointerUp={(event) => !canHover(event) && setPinned((p) => !p)}
      >
        {balance == null ? (
          <span className={`${styles.balance} ${styles.balancePending}`}>—</span>
        ) : (
          <Balance value={balance} />
        )}
      </button>

      {offArc ? (
        <motion.button
          type="button"
          className={`${styles.deposit} ${styles.switchNetwork}`}
          // Not `disabled`, which would drop keyboard focus mid-switch.
          aria-disabled={switching || undefined}
          whileHover={switching ? undefined : { scale: 1.04 }}
          whileTap={switching ? undefined : { scale: 0.94 }}
          transition={spring}
          onClick={onSwitchToArc}
        >
          Switch to Arc
        </motion.button>
      ) : (
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
      )}

      {/* Mounted while off Arc, so screen readers announce the message when it appears. */}
      {offArc && (
        <p role="status" className={styles.switchStatus}>
          {cantSwitch &&
            "This wallet couldn't switch to Arc. Add Arc (chain ID 5042) in its network settings, or connect another wallet."}
        </p>
      )}

      {/* Floats over the positions instead of pushing them down. */}
      <AnimatePresence>
        {showHistory && deposits.length > 0 && (
          <motion.div
            key="history"
            className={styles.historyFrame}
            initial="hidden"
            animate="shown"
            exit="hidden"
          >
            <ol ref={historyRef} className={styles.history} aria-label="Deposits">
              <AnimatePresence>
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
            </ol>
            <ScrollEdges />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function balanceLabel(balance: number | null | undefined) {
  if (balance === undefined) return "loading";
  if (balance === null) return "unavailable";
  return formatUsd(balance);
}

/** Blurred overlays for the scroll container just before them; they show
    where `trackScrollEdges` marks content hidden past an edge. They sit
    outside the scroller so the blur reads the finished, scrolled picture. */
function ScrollEdges() {
  return (
    <>
      <span className={`${styles.edge} ${styles.edgeTop}`} data-edge="top" aria-hidden="true" />
      <span className={`${styles.edge} ${styles.edgeBottom}`} data-edge="bottom" aria-hidden="true" />
    </>
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
