"use client";

import { useSyncExternalStore, type ComponentType, type SVGProps } from "react";
import { usePathname } from "next/navigation";
import { MotionConfig } from "motion/react";
import type { SentencePart } from "@/lib/sentence";
import { BarsIcon, TrendIcon } from "./icons";
import { PillBody, PillLink } from "./sentence/pill";
import { Sentence, sentenceType } from "./sentence/sentence";

const word = (text: string, glue = ""): SentencePart => ({ kind: "word", key: text, text, glue });
const slot = (name: string, glue = ""): SentencePart => ({ kind: "slot", key: name, slot: name, glue });

const PARTS: SentencePart[] = [
    word("There’s"),
    word("nothing"),
    word("at"),
    slot("path", "."),
    // One word to the layout, so a narrow screen never breaks "Take me to" apart.
    word("Take me to"),
    slot("trade"),
    word("or"),
    slot("pnl", "."),
];

/** A page's mark, as its dock tile draws it. */
function PageMark({ icon: Icon }: { icon: ComponentType<SVGProps<SVGSVGElement>> }) {
    return (
        <span className="grid size-[1.15em] place-items-center rounded-full bg-foreground text-background">
            <Icon className="size-[48%]" />
        </span>
    );
}

/** The address as it was asked for, readable: "/wallet/my coins" rather than "/wallet/my%20coins". */
function readable(path: string) {
    try {
        return decodeURI(path);
    } catch {
        return path;
    }
}

const noChanges = () => () => {};

/**
 * The address that isn't a page, or null until the page runs in the browser:
 * the server renders a 404 under its own route, so only the browser knows it.
 */
function useMissingAddress() {
    const pathname = usePathname();
    const inBrowser = useSyncExternalStore(
        noChanges,
        () => true,
        () => false,
    );
    return inBrowser ? readable(pathname) : null;
}

/**
 * The 404 in the trade page's own voice: one sentence that says what isn't
 * here, in a pill of its own, and offers the pages that are as pills to go to.
 */
export function NotFoundSentence() {
    const address = useMissingAddress();

    const renderSlot = (name: string) => {
        if (name === "path")
            return (
                // Muted and still: an address, not a choice. It springs in once known; a long one ends in an ellipsis, whole on hover.
                <span className="inline-flex max-w-full text-muted" title={address ?? undefined}>
                    <PillBody contentKey={address ?? "unknown"}>{address ?? "this address"}</PillBody>
                </span>
            );
        if (name === "trade")
            return (
                <PillLink href="/" contentKey="trade" icon={<PageMark icon={TrendIcon} />}>
                    Trade
                </PillLink>
            );
        return (
            <PillLink href="/pnl" contentKey="pnl" icon={<PageMark icon={BarsIcon} />}>
                PnL
            </PillLink>
        );
    };

    return (
        <MotionConfig reducedMotion="user">
            <Sentence parts={PARTS} renderVerb={() => null} renderSlot={renderSlot} className={sentenceType} />
        </MotionConfig>
    );
}
