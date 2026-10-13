import type { Outcome, PredictionMarket } from "@/lib/trade/catalog";

export const QUESTION_LINES = 4;

const isYesNo = (market: PredictionMarket) => {
    const labels = market.outcomes.map((o) => o.label.toUpperCase());
    return labels.length === 2 && labels.includes("YES") && labels.includes("NO");
};

const labelIs = (outcome: Outcome, label: string) => outcome.label.toUpperCase() === label;

/** The outcomes the question card draws: YES alone for a Yes/No question, else up to 4 by chance, most likely first; `more` counts the rest. */
export function chartedOutcomes(market: PredictionMarket): { drawn: Outcome[]; more: number } {
    if (isYesNo(market)) {
        return { drawn: market.outcomes.filter((o) => labelIs(o, "YES")), more: 0 };
    }
    // Array.sort is stable, so ties keep the market's order.
    const ranked = [...market.outcomes].sort((a, b) => b.chance - a.chance);
    const drawn = ranked.slice(0, QUESTION_LINES);
    return { drawn, more: ranked.length - drawn.length };
}

/** The tokens both cards need, charted first, then the picked outcome if it isn't charted. */
export function historyTokens(market: PredictionMarket, outcomeId: string | null): string[] {
    const tokens = chartedOutcomes(market).drawn.map((o) => o.id);
    if (outcomeId && !tokens.includes(outcomeId)) tokens.push(outcomeId);
    return tokens;
}

/** The palette slot ("--chart-1" to "--chart-4") or tone ("--gain", "--loss") an outcome's line uses. */
export function lineColor(market: PredictionMarket, outcomeId: string): string {
    if (isYesNo(market)) {
        const outcome = market.outcomes.find((o) => o.id === outcomeId);
        if (outcome) return labelIs(outcome, "YES") ? "--gain" : "--loss";
    }
    const rank = chartedOutcomes(market).drawn.findIndex((o) => o.id === outcomeId);
    return `--chart-${rank < 0 ? 1 : rank + 1}`;
}
