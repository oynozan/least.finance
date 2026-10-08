"use client";

import { motion, type Variants } from "motion/react";
import type { Preview } from "@/lib/sentence";

const TONE = { gain: "text-gain", loss: "text-loss", neutral: "" } as const;

const rowVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  shown: { opacity: 1, y: 0, transition: { type: "spring", visualDuration: 0.3, bounce: 0.2 } },
};

/** What the sentence will do: what you pay, what you get, what can go wrong. */
export function TransactionPreview({ preview }: { preview: Preview }) {
  const primary = preview.rows.filter((row) => row.primary);
  const secondary = preview.rows.filter((row) => !row.primary);

  return (
    <section aria-label="Details" className="flex flex-col gap-3">
      {preview.title && (
        <motion.p variants={rowVariants} className="text-[15px] leading-snug text-muted">
          {preview.title}
        </motion.p>
      )}
      <dl className="flex flex-col gap-3 rounded-[28px] bg-pill px-5 py-5">
        {primary.map((row) => (
          <motion.div key={row.id} variants={rowVariants} className="flex flex-col gap-0.5">
            <dt className="text-[14px] text-muted">{row.label}</dt>
            <dd className={`text-[22px] font-medium tracking-[-0.015em] tabular-nums ${TONE[row.tone ?? "neutral"]}`}>
              {row.value}
            </dd>
          </motion.div>
        ))}
        {secondary.length > 0 && <div className="my-1 h-px bg-white/[0.06]" aria-hidden="true" />}
        {secondary.map((row) => (
          <motion.div
            key={row.id}
            variants={rowVariants}
            className="flex items-baseline justify-between gap-4 text-[15px]"
          >
            <dt className="shrink-0 text-muted">{row.label}</dt>
            <dd className={`text-right tabular-nums ${row.tone ? TONE[row.tone] : "text-foreground/85"}`}>
              {row.value}
            </dd>
          </motion.div>
        ))}
      </dl>
    </section>
  );
}
