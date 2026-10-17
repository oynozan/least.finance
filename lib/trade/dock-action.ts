import { VERB_SLOT, type SentenceView } from "@/lib/sentence";

/**
 * What the dock's button says and does:
 * - review: nothing blocks the sentence, so it opens the review;
 * - open: a pill of the sentence (the verb's too) holds the problem, and the button names the way out and opens that pill;
 * - blocked: nothing in the sentence fixes it, so the button names the problem and can't be pressed.
 */
export type DockAction =
    | { kind: "review" }
    | { kind: "open"; label: string; message: string; slot: string }
    | { kind: "blocked"; label: string; message: string };

/** The button for a sentence: its first blocking issue's action label, or the review. */
export function dockAction(view: Pick<SentenceView<unknown>, "blocking" | "slots">): DockAction {
    const issue = view.blocking;
    if (!issue) return { kind: "review" };
    const label = issue.cta ?? "Review";
    // The verb's pill is a pill too: its picker offers the other trades
    return issue.slot && (issue.slot === VERB_SLOT || view.slots[issue.slot])
        ? { kind: "open", label, message: issue.message, slot: issue.slot }
        : { kind: "blocked", label, message: issue.message };
}
