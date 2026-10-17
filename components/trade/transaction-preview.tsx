"use client";

import { useState } from "react";
import { motion, type Variants } from "motion/react";
import type { Preview, PreviewRow } from "@/lib/sentence";

const TONE = { gain: "text-gain", loss: "text-loss", neutral: "" } as const;

const rowVariants: Variants = {
    hidden: { opacity: 0, y: 10 },
    shown: { opacity: 1, y: 0, transition: { type: "spring", visualDuration: 0.3, bounce: 0.2 } },
};

// Open while the card is pointed at, keyboard-focused or tapped; opening waits a beat so a passing pointer leaves it still.
const OPEN =
    "group-hover:grid-rows-[1fr] group-hover:opacity-100 group-hover:delay-[90ms] group-hover:duration-[420ms] group-hover:ease-spring group-focus-visible:grid-rows-[1fr] group-focus-visible:opacity-100 group-focus-visible:duration-[420ms] group-focus-visible:ease-spring group-data-open:grid-rows-[1fr] group-data-open:opacity-100 group-data-open:duration-[420ms] group-data-open:ease-spring";

function SmallRow({ row }: { row: PreviewRow }) {
    return (
        <div className="flex items-baseline justify-between gap-4 text-[15px]">
            <dt className="shrink-0 text-muted">{row.label}</dt>
            <dd className={`text-right tabular-nums ${row.tone ? TONE[row.tone] : "text-foreground/85"}`}>
                {row.value}
            </dd>
        </div>
    );
}

/**
 * What the sentence will do: what you pay and what you get, and what can go
 * wrong, always in view. The rest (the least you'll get, fees, gas, time,
 * route) opens at the card's foot only while it's pointed at, focused or tapped.
 */
export function TransactionPreview({ preview }: { preview: Preview }) {
    const [tapped, setTapped] = useState(false);
    const primary = preview.rows.filter((row) => row.primary);
    const warnings = preview.rows.filter((row) => !row.primary && row.tone === "loss");
    const details = preview.rows.filter((row) => !row.primary && row.tone !== "loss");

    return (
        <section aria-label="Details" className="flex flex-col gap-3">
            {preview.title && (
                <motion.p variants={rowVariants} className="text-[15px] leading-snug text-muted">
                    {preview.title}
                </motion.p>
            )}
            {preview.rows.length > 0 && (
                <motion.div
                    variants={rowVariants}
                    className="group rounded-[28px] bg-pill px-5 py-5 outline-none focus-visible:shadow-[0_0_0_2px_rgb(255_255_255/0.28)]"
                    data-preview-card=""
                    tabIndex={details.length > 0 ? 0 : undefined}
                    data-open={tapped || undefined}
                    // A mouse opens it by pointing; a tap opens it and the next one closes it.
                    onPointerUp={(event) => details.length > 0 && event.pointerType !== "mouse" && setTapped((t) => !t)}
                >
                    <dl className="flex flex-col gap-3">
                        {primary.map((row) => (
                            <div key={row.id} className="flex flex-col gap-0.5">
                                <dt className="text-[14px] text-muted">{row.label}</dt>
                                <dd
                                    className={`text-[22px] font-medium tracking-[-0.015em] tabular-nums ${TONE[row.tone ?? "neutral"]}`}
                                >
                                    {row.value}
                                </dd>
                                {row.note && <dd className="text-[14px] text-muted">{row.note}</dd>}
                            </div>
                        ))}
                        {warnings.length > 0 && <div className="my-1 h-px bg-white/[0.06]" aria-hidden="true" />}
                        {warnings.map((row) => (
                            <SmallRow key={row.id} row={row} />
                        ))}
                    </dl>
                    {details.length > 0 && (
                        <div
                            data-preview-details=""
                            className={`grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-200 ease-out ${OPEN}`}
                        >
                            <div className="min-h-0 overflow-hidden">
                                {warnings.length === 0 && (
                                    <div className="mt-4 h-px bg-white/[0.06]" aria-hidden="true" />
                                )}
                                <dl className="flex flex-col gap-3 pt-4">
                                    {details.map((row) => (
                                        <SmallRow key={row.id} row={row} />
                                    ))}
                                </dl>
                            </div>
                        </div>
                    )}
                </motion.div>
            )}
        </section>
    );
}
