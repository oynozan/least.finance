"use client";

import NumberFlow from "@number-flow/react";
import type { StatsFees } from "@/server/src/protocol";

const dollars = { style: "currency", currency: "USD" } as const;

/** The fees we've earned over the range the money card shows. */
export function FeesCard({ fees }: { fees: StatsFees }) {
    return (
        <section aria-labelledby="fees-title" className="rounded-[34px] bg-panel p-6 sm:p-8">
            <h2 id="fees-title" className="text-base font-medium tracking-[-0.01em] text-muted">
                Fees
            </h2>
            <p className="mt-2 text-[clamp(32px,1.2rem+2vw,44px)] leading-none font-medium tracking-[-0.03em]">
                <NumberFlow value={Number(fees.totalUsd)} format={dollars} willChange />
            </p>
            <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-[15px] text-muted">
                <div className="flex gap-2">
                    <dt>Spread</dt>
                    <dd className="tabular-nums">
                        <NumberFlow value={Number(fees.spreadUsd)} format={dollars} />
                    </dd>
                </div>
                <div className="flex gap-2">
                    <dt>Perp fee</dt>
                    <dd className="tabular-nums">
                        <NumberFlow value={Number(fees.perpUsd)} format={dollars} />
                    </dd>
                </div>
            </dl>
        </section>
    );
}
