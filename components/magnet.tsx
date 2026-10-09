"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, type SpringOptions } from "motion/react";

type MagnetProps = {
    children: ReactNode;
    className?: string;
    /** How far outside its box, in px, the pointer starts pulling. */
    padding?: number;
    /** Higher is weaker: the offset is the pointer distance divided by this. */
    magnetStrength?: number;
    disabled?: boolean;
};

const follow: SpringOptions = { visualDuration: 0.3, bounce: 0.3 };

/**
 * Pulls its children toward the pointer while it is within `padding` of
 * them, after React Bits' Magnet. Offsets live in motion values and spring
 * back, so pointer moves never re-render.
 */
export function Magnet({ children, className, padding = 100, magnetStrength = 2, disabled = false }: MagnetProps) {
    const ref = useRef<HTMLDivElement>(null);
    const reduceMotion = useReducedMotion();
    const offsetX = useMotionValue(0);
    const offsetY = useMotionValue(0);
    const x = useSpring(offsetX, follow);
    const y = useSpring(offsetY, follow);

    useEffect(() => {
        const release = () => {
            offsetX.set(0);
            offsetY.set(0);
        };
        if (disabled || reduceMotion) return release();

        // Measures the wrapper, which never moves, so the pull doesn't feed back
        // into its own hit area.
        const onPointerMove = (event: PointerEvent) => {
            // Touch has no hover; a tap would only make the button jump.
            if (event.pointerType === "touch" || !ref.current) return;
            const { left, top, width, height } = ref.current.getBoundingClientRect();
            const dx = event.clientX - (left + width / 2);
            const dy = event.clientY - (top + height / 2);

            if (Math.abs(dx) < width / 2 + padding && Math.abs(dy) < height / 2 + padding) {
                offsetX.set(dx / magnetStrength);
                offsetY.set(dy / magnetStrength);
            } else {
                release();
            }
        };

        window.addEventListener("pointermove", onPointerMove);
        document.documentElement.addEventListener("pointerleave", release);
        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            document.documentElement.removeEventListener("pointerleave", release);
        };
    }, [disabled, reduceMotion, padding, magnetStrength, offsetX, offsetY]);

    return (
        <div ref={ref} className={className} style={{ display: "inline-block" }}>
            <motion.div style={{ x, y }}>{children}</motion.div>
        </div>
    );
}
