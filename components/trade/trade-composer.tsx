"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { MotionConfig } from "motion/react";
import type { SentenceAction, SentenceView, SlotView } from "@/lib/sentence";
import type { TransactionIntent } from "@/lib/trade/intent";
import { SentenceIcons } from "@/components/sentence/icons";
import { Sentence } from "@/components/sentence/sentence";
import { ChoiceSlot, NumberSlot } from "@/components/sentence/slots";
import { renderTradeIcon } from "./trade-icons";

type TradeComposerProps = {
    view: SentenceView<TransactionIntent>;
    dispatch: (action: SentenceAction) => void;
    /** Answers the question picker's search; absent in demo mode. */
    search?: { onQuery: (query: string) => void; empty?: string; loading?: boolean };
};

const shownValue = (slot: SlotView) => {
    if (slot.kind !== "choice") return `${slot.value || "0"}${slot.suffix ?? ""}`;
    const network = slot.then?.selected;
    return slot.selected && network
        ? `${slot.selected.label} on ${network.label}`
        : (slot.selected?.label ?? "nothing");
};

/** One polite status region; clearing it first makes a repeated message speak again. */
function useAnnouncer() {
    const [message, setMessage] = useState("");
    const timer = useRef<number | undefined>(undefined);
    const announce = useCallback((text: string, delay = 60) => {
        window.clearTimeout(timer.current);
        setMessage("");
        timer.current = window.setTimeout(() => setMessage(text), delay);
    }, []);
    useEffect(() => () => window.clearTimeout(timer.current), []);
    return { message, announce };
}

/**
 * The trade sentence itself. Fully controlled: the view and dispatch come
 * from the shared trade state. The details live in the review sidebar.
 */
export function TradeComposer({ view, dispatch, search }: TradeComposerProps) {
    const headingId = useId();
    const issueId = useId();
    const [typing, setTyping] = useState(false);
    const edited = useRef<string | null>(null);
    const { message, announce } = useAnnouncer();

    // A companion slot (a coin's network) is edited as part of its host's pill, so it names the host.
    const set = (slot: string, value: string, host = slot) => {
        edited.current = host;
        dispatch({ type: "slot", slot, value });
    };

    // The page shows nothing but the sentence: a problem turns its pill's text
    // red and keeps Review disabled; its wording is only read out.
    const notice =
        view.issues.find((issue) => issue.severity === "error") ??
        view.issues.find((issue) => issue.severity === "warning");

    // What to read out after a change: the whole sentence for a new verb,
    // otherwise only side effects on slots the user didn't just edit (a swap
    // flipping, leverage being capped), plus a new problem if there is one.
    const shownKey = JSON.stringify(
        Object.fromEntries(Object.values(view.slots).map((slot) => [slot.id, shownValue(slot)])),
    );
    const last = useRef<{ verb: string; shown: Record<string, string>; issue?: string } | null>(null);
    useEffect(() => {
        const prev = last.current;
        const current = {
            verb: view.verb.id,
            shown: JSON.parse(shownKey) as Record<string, string>,
            issue: notice?.message,
        };
        last.current = current;
        if (!prev) return;
        const lines: string[] = [];
        if (prev.verb !== current.verb) lines.push(view.text);
        else {
            for (const [id, value] of Object.entries(current.shown)) {
                if (id !== edited.current && id in prev.shown && prev.shown[id] !== value) {
                    lines.push(`${view.slots[id].hint} is now ${value}.`);
                }
            }
        }
        if (current.issue && current.issue !== prev.issue) lines.push(current.issue);
        if (lines.length) announce(lines.join(" "), typing ? 900 : 60);
    }, [view.verb.id, view.text, view.slots, shownKey, notice?.message, typing, announce]);

    const renderSlot = (id: string) => {
        const slot = view.slots[id];
        const companion = slot.kind === "choice" ? slot.then : undefined;
        return (
            <span data-slot={id} className="contents">
                {slot.kind === "choice" ? (
                    <ChoiceSlot
                        view={slot}
                        loading={slot.search ? search?.loading : undefined}
                        onChange={(value) => set(id, value)}
                        onThen={companion && ((value) => set(companion.id, value, id))}
                        onSearch={search?.onQuery}
                        searchEmpty={search?.empty}
                    />
                ) : (
                    <NumberSlot
                        view={slot}
                        describedBy={slot.issue?.severity === "error" ? issueId : undefined}
                        onChange={(value) => set(id, value)}
                        onFocusChange={setTyping}
                    />
                )}
            </span>
        );
    };

    const renderVerb = () => (
        <span data-slot="verb" className="contents">
            <ChoiceSlot
                view={{
                    prompt: "What do you want to do?",
                    hint: "Action",
                    value: view.verb.id,
                    selected: view.verbChoices.find((choice) => choice.value === view.verb.id),
                    choices: view.verbChoices,
                }}
                onChange={(verbId) => {
                    edited.current = "verb";
                    dispatch({ type: "verb", verbId });
                }}
            />
        </span>
    );

    return (
        <MotionConfig reducedMotion="user">
            <SentenceIcons render={renderTradeIcon}>
                <section aria-labelledby={headingId} className="flex w-full flex-col items-center">
                    <h1 id={headingId} className="sr-only">
                        Trade
                    </h1>

                    <Sentence
                        parts={view.parts}
                        renderVerb={renderVerb}
                        renderSlot={renderSlot}
                        className="w-[min(18em,100%)] text-center text-[clamp(28px,min(max(min(1rem+2.6vw,47px),2.75vw),9vh),120px)] leading-[1.36] font-medium tracking-[-0.02em] text-balance [word-spacing:-0.07em] pointer-coarse:leading-[1.5]"
                    />

                    <p id={issueId} className="sr-only">
                        {notice?.message}
                    </p>

                    <p role="status" className="sr-only">
                        {message}
                    </p>
                </section>
            </SentenceIcons>
        </MotionConfig>
    );
}
