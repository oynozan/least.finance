import type { SeededDeposit } from "./backend";

/**
 * A long deposit history, newest first: enough rows to overflow the
 * sidebar, so scrolling and the reveal stagger have something to work on.
 */
export const HISTORY: SeededDeposit[] = [
    { amount: "2500", daysAgo: 2 },
    { amount: "1840.25", daysAgo: 9 },
    { amount: "5000", daysAgo: 23 },
    { amount: "3000", daysAgo: 41 },
    { amount: "1200", daysAgo: 48 },
    { amount: "4120.8", daysAgo: 55 },
    { amount: "750", daysAgo: 63 },
    { amount: "610.4", daysAgo: 71 },
    { amount: "2000", daysAgo: 84 },
    { amount: "980.15", daysAgo: 97 },
    { amount: "1500", daysAgo: 112 },
    { amount: "300", daysAgo: 126 },
    { amount: "2264.9", daysAgo: 141 },
    { amount: "5000", daysAgo: 158 },
    { amount: "1420.6", daysAgo: 173 },
    { amount: "850", daysAgo: 190 },
    { amount: "455.3", daysAgo: 208 },
    { amount: "2500", daysAgo: 229 },
    { amount: "1000", daysAgo: 251 },
    { amount: "3105.75", daysAgo: 276 },
];

/** What HISTORY adds up to. */
export const HISTORY_TOTAL = HISTORY.reduce((sum, d) => sum + Number(d.amount), 0);
