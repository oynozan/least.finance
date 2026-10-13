"use client";

import { useRef, useState, type ComponentType, type SVGProps } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    AnimatePresence,
    MotionConfig,
    motion,
    useAnimate,
    useMotionValue,
    useReducedMotion,
    useSpring,
    useTransform,
    type MotionValue,
    type SpringOptions,
    type Transition,
} from "motion/react";
import { BarsIcon, TrendIcon } from "./icons";
import { ReviewButton } from "./trade/review-button";
import { useTrade } from "./trade/trade-provider";

/** A tile's size at rest and right under the pointer, and how far the swell reaches either side, in px. */
const BASE = 48;
const PEAK = 68;
const REACH = 150;

/** After React Bits' Dock: light and quick, with a little overshoot. */
const swell: SpringOptions = { mass: 0.1, stiffness: 150, damping: 12 };
const pop: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.35 };
const slide: Transition = { type: "spring", visualDuration: 0.4, bounce: 0.2 };

type Page = { href: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> };

const PAGES: Page[] = [
    { href: "/", label: "Trade", icon: TrendIcon },
    { href: "/pnl", label: "PnL", icon: BarsIcon },
];

/**
 * The bottom dock, after React Bits' Dock: page tiles swell toward the
 * pointer and hop when pressed. On the trade page it also holds Review.
 */
export function Dock() {
    const pathname = usePathname();
    const { wallet } = useTrade();
    const pointerX = useMotionValue(Infinity);
    const canReview = pathname === "/" && wallet.status === "connected";

    return (
        <MotionConfig reducedMotion="user">
            <nav
                aria-label="Pages"
                className="absolute bottom-[max(24px,env(safe-area-inset-bottom))] left-1/2 z-20 flex h-16 -translate-x-1/2 items-end gap-2 rounded-full bg-panel p-2 shadow-[0_0_0_1px_rgb(255_255_255/0.07),0_20px_50px_-16px_rgb(0_0_0/0.75)]"
                onPointerMove={(event) => {
                    if (event.pointerType === "mouse") pointerX.set(event.clientX);
                }}
                onPointerLeave={() => pointerX.set(Infinity)}
            >
                {PAGES.map((page) => (
                    <DockTile key={page.href} page={page} active={pathname === page.href} pointerX={pointerX} />
                ))}
                <AnimatePresence initial={false}>
                    {canReview && (
                        <motion.div
                            key="review"
                            // Clipped while it slides open; the margin leaves room for its hover swell.
                            className="flex items-center self-center [overflow-clip-margin:12px] [overflow:clip]"
                            initial={{ width: 0, opacity: 0 }}
                            animate={{ width: "auto", opacity: 1 }}
                            exit={{ width: 0, opacity: 0 }}
                            transition={slide}
                        >
                            <span aria-hidden="true" className="mr-2 ml-1 h-7 w-px shrink-0 rounded-full bg-white/10" />
                            <ReviewButton />
                        </motion.div>
                    )}
                </AnimatePresence>
            </nav>
        </MotionConfig>
    );
}

function DockTile({ page, active, pointerX }: { page: Page; active: boolean; pointerX: MotionValue<number> }) {
    const ref = useRef<HTMLDivElement>(null);
    const reduce = useReducedMotion();
    const [hovered, setHovered] = useState(false);
    const [tile, animate] = useAnimate<HTMLAnchorElement>();
    const Icon = page.icon;

    // A cosine-squared swell around the pointer, as in React Bits' Dock.
    const target = useTransform(pointerX, (x) => {
        const rect = ref.current?.getBoundingClientRect();
        if (reduce || !rect || !Number.isFinite(x)) return BASE;
        const reach = Math.abs(x - (rect.left + rect.width / 2)) / REACH;
        return reach < 1 ? BASE + (PEAK - BASE) * Math.cos((reach * Math.PI) / 2) ** 2 : BASE;
    });
    const size = useSpring(target, swell);

    const hop = () => {
        if (!reduce)
            animate(
                tile.current,
                { y: [0, -14, 0] },
                { duration: 0.42, times: [0, 0.42, 1], ease: ["easeOut", "easeIn"] },
            );
    };

    return (
        <motion.div ref={ref} className="relative shrink-0" style={{ width: size, height: size }}>
            <Link
                ref={tile}
                href={page.href}
                aria-label={page.label}
                aria-current={active ? "page" : undefined}
                className={`grid size-full place-items-center rounded-full outline-none transition-colors duration-200 focus-visible:shadow-[0_0_0_3px_rgb(255_255_255/0.28)] ${
                    active ? "bg-foreground text-background" : "bg-pill text-foreground hover:bg-pill-hover"
                }`}
                onPointerEnter={() => setHovered(true)}
                onPointerLeave={() => setHovered(false)}
                onFocus={(event) => setHovered(event.currentTarget.matches(":focus-visible"))}
                onBlur={() => setHovered(false)}
                onClick={hop}
            >
                <Icon className="size-[42%]" />
            </Link>
            <AnimatePresence>
                {hovered && (
                    <motion.span
                        aria-hidden="true"
                        className="pointer-events-none absolute bottom-full left-1/2 mb-2.5 -translate-x-1/2 rounded-full bg-pill-hover px-3 py-1.5 text-[13px] leading-none font-medium whitespace-nowrap shadow-[0_8px_20px_-8px_rgb(0_0_0/0.6)]"
                        initial={{ opacity: 0, y: 6, scale: 0.85 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 4, scale: 0.9 }}
                        transition={pop}
                    >
                        {page.label}
                    </motion.span>
                )}
            </AnimatePresence>
        </motion.div>
    );
}
