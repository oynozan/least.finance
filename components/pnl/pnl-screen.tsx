"use client";

import { MotionConfig, motion, type Transition } from "motion/react";
import { ActivityCard } from "./activity-card";
import { BalanceCard } from "./balance-card";
import { useActivity } from "./use-activity";

const rise: Transition = { type: "spring", visualDuration: 0.45, bounce: 0.25 };

/** The balance over time, and every operation behind it. */
export function PnlScreen() {
    const state = useActivity();

    return (
        <MotionConfig reducedMotion="user">
            <div className="relative h-dvh">
                {/* Scrolls on its own, so the wallet button and the dock stay put over it. */}
                <main className="h-full overflow-y-auto [scrollbar-width:none]">
                    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 px-4 pt-[96px] pb-[136px]">
                        <h1 className="sr-only">PnL</h1>
                        {state.status === "ready" ? (
                            <>
                                <motion.div
                                    initial={{ opacity: 0, y: 24, scale: 0.98 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    transition={rise}
                                >
                                    <BalanceCard activity={state.activity} now={state.now} />
                                </motion.div>
                                <motion.div
                                    initial={{ opacity: 0, y: 24, scale: 0.98 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    transition={{ ...rise, delay: 0.08 }}
                                >
                                    <ActivityCard activity={state.activity} />
                                </motion.div>
                            </>
                        ) : state.status === "signed-out" ? (
                            <SignedOut connect={state.connect} />
                        ) : (
                            <Placeholder />
                        )}
                    </div>
                </main>
                {/* Content fades out under the wallet button and the dock. */}
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-linear-to-b from-background to-transparent"
                />
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-linear-to-t from-background to-transparent"
                />
            </div>
        </MotionConfig>
    );
}

function SignedOut({ connect }: { connect: () => void }) {
    return (
        <motion.section
            className="mt-[12vh] flex flex-col items-center gap-6 rounded-[34px] bg-panel px-6 py-14 text-center"
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={rise}
        >
            <p className="max-w-[22ch] text-[28px] leading-[1.2] font-medium tracking-[-0.02em] text-balance">
                Connect a wallet to see your balance and PnL.
            </p>
            <motion.button
                type="button"
                className="h-12 cursor-pointer rounded-full bg-foreground px-6 text-[17px] font-semibold tracking-[-0.01em] text-background outline-2 outline-offset-2 outline-transparent focus-visible:outline-solid"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.92 }}
                transition={{ type: "spring", visualDuration: 0.35, bounce: 0.45 }}
                onClick={connect}
            >
                Connect wallet
            </motion.button>
        </motion.section>
    );
}

/** The cards' shapes while the account loads. */
function Placeholder() {
    return (
        <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
            <div className="h-[420px] animate-pulse rounded-[34px] bg-panel" />
            <div className="h-[320px] animate-pulse rounded-[34px] bg-panel" />
        </div>
    );
}
