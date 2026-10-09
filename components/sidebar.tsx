"use client";

import { createContext, use, useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { motion, useReducedMotion, useSpring, useTransform, type SpringOptions } from "motion/react";
import styles from "./sidebar.module.css";

/** What the sidebar shows: the wallet, or the review of a trade. */
export type SidebarView = "wallet" | "review";

type SidebarState = {
    open: boolean;
    setOpen: (open: boolean) => void;
    /** Opens the wallet, or closes it if the wallet is already showing. */
    toggle: () => void;
    view: SidebarView;
    /** Opens the sidebar on the given view. */
    show: (view: SidebarView) => void;
};

const SidebarContext = createContext<SidebarState | null>(null);

export function useSidebar() {
    const context = use(SidebarContext);
    if (!context) throw new Error("useSidebar must be used inside <SidebarShell>");
    return context;
}

export const SIDEBAR_ID = "wallet-sidebar";

/** Below this viewport width the sidebar takes the whole screen. */
const FULL_SCREEN_BELOW = 560;
const WIDTH = 400;
/** Extra panel past the right edge, so the push spring can overshoot
    without opening a gap. */
const BLEED = 48;

const push: SpringOptions = { visualDuration: 0.5, bounce: 0.18 };

const subscribeResize = (onChange: () => void) => {
    window.addEventListener("resize", onChange);
    return () => window.removeEventListener("resize", onChange);
};
/** The sidebar's width, or 0 when it should cover the whole screen. */
const sidebarWidth = () => (window.innerWidth < FULL_SCREEN_BELOW ? 0 : WIDTH);
const viewportWidth = () => window.innerWidth;

/**
 * Wraps the page in a row with a right-hand sidebar. Opening it springs a
 * margin onto the page, pushing it left, and the fixed panel rides the same
 * motion value so the two can never drift apart. On narrow screens the
 * sidebar covers everything, so the page slides out whole instead of being
 * squeezed to nothing.
 */
export function SidebarShell({
    children,
    panel,
    review,
}: {
    children: ReactNode;
    /** The wallet view. */
    panel: ReactNode;
    /** The trade review view. */
    review: ReactNode;
}) {
    const [open, setOpenState] = useState(false);
    const [view, setView] = useState<SidebarView>("wallet");
    // A plain open (e.g. after connecting from the dock) shows the wallet
    // rather than an old review. Closing keeps the view, so it stays in place
    // while the panel slides away.
    const setOpen = useCallback((next: boolean) => {
        setOpenState(next);
        if (next) setView("wallet");
    }, []);
    const fixedWidth = useSyncExternalStore(subscribeResize, sidebarWidth, () => WIDTH);
    const viewport = useSyncExternalStore(subscribeResize, viewportWidth, () => 0);
    const fullScreen = fixedWidth === 0;
    const width = fullScreen ? viewport : fixedWidth;
    const reduceMotion = useReducedMotion();

    const offset = useSpring(0, push);
    const x = useTransform(offset, (pushed) => width - pushed);
    const margin = useTransform(offset, (pushed) => (fullScreen ? 0 : pushed));
    const slide = useTransform(offset, (pushed) => (fullScreen ? -pushed : 0));

    useEffect(() => {
        const target = open ? width : 0;
        if (reduceMotion) offset.jump(target);
        else offset.set(target);
    }, [open, width, offset, reduceMotion]);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open, setOpen]);

    const show = (next: SidebarView) => {
        setView(next);
        setOpenState(true);
    };
    const state: SidebarState = {
        open,
        setOpen,
        toggle: () => (open && view === "wallet" ? setOpen(false) : show("wallet")),
        view,
        show,
    };
    // The wallet panel only counts as open while it is the one showing, so
    // opening a review doesn't replay its entrance or refresh its balance.
    const walletState: SidebarState = { ...state, open: open && view === "wallet" };

    return (
        <SidebarContext value={state}>
            <motion.div className={styles.page} style={{ marginRight: margin, x: slide }}>
                {children}
            </motion.div>
            <motion.aside
                id={SIDEBAR_ID}
                aria-label={view === "review" ? "Review" : "Wallet"}
                className={styles.panel}
                inert={!open}
                data-open={open}
                style={{ x, width: width + BLEED, right: -BLEED, paddingRight: BLEED }}
            >
                <div className={styles.inner}>
                    <div className={styles.view} style={view === "wallet" ? undefined : { display: "none" }}>
                        <SidebarContext value={walletState}>{panel}</SidebarContext>
                    </div>
                    <div className={styles.view} style={view === "review" ? undefined : { display: "none" }}>
                        {review}
                    </div>
                </div>
            </motion.aside>
        </SidebarContext>
    );
}
