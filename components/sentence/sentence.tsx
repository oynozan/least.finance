"use client";

import { useId, type ReactNode, type Ref } from "react";
import { AnimatePresence, LayoutGroup, motion, useIsPresent, useReducedMotion, type Transition } from "motion/react";
import type { SentencePart } from "@/lib/sentence";
import { layoutSpring } from "./motion";

const enterSpring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.35 };
const exitTween: Transition = { duration: 0.16, ease: "easeIn" };

/** A page's sentence lettering: large, tight and centered, scaled to the window. */
export const sentenceType =
    "w-[min(18em,100%)] text-center text-[clamp(28px,min(max(min(1rem+2.6vw,47px),2.75vw),9vh),120px)] leading-[1.36] font-medium tracking-[-0.02em] text-balance [word-spacing:-0.07em] pointer-coarse:leading-[1.5]";

type SentenceProps = {
    parts: readonly SentencePart[];
    renderVerb: () => ReactNode;
    renderSlot: (slot: string) => ReactNode;
    className?: string;
};

/**
 * Renders a sentence of words and pills that restructures with springs:
 * items that persist (by key) glide to their new places, removed ones fade
 * out where they were, new ones spring in.
 */
export function Sentence({ parts, renderVerb, renderSlot, className = "" }: SentenceProps) {
    const groupId = useId();
    const reduce = useReducedMotion() ?? false;
    // A mark that appears twice (two sentences' full stops) is two marks: the nth of each keeps its identity.
    const marks = new Map<string, number>();
    const markId = (glue: string) => {
        const nth = marks.get(glue) ?? 0;
        marks.set(glue, nth + 1);
        return `${glue}:${nth}`;
    };

    return (
        // Positioned, so leaving items can be pinned where they were; a definite
        // width (not shrink-to-fit), so the pinned ones don't drift as it re-centers.
        <p data-sentence="" className={`relative ${className}`}>
            <LayoutGroup id={groupId}>
                <AnimatePresence mode="popLayout" initial={false}>
                    {parts.flatMap((part, i) => {
                        const nodes = [
                            <Item
                                key={part.key}
                                itemKey={part.key}
                                index={i}
                                reduce={reduce}
                                glue={part.glue}
                                glueId={part.glue && markId(part.glue)}
                            >
                                {part.kind === "word"
                                    ? part.text
                                    : part.kind === "verb"
                                      ? renderVerb()
                                      : renderSlot(part.slot)}
                            </Item>,
                        ];
                        // A real, keyed space: AnimatePresence drops bare strings, and a
                        // space inside an inline-block would be trimmed.
                        if (i < parts.length - 1) nodes.push(<span key={`${part.key}~`}> </span>);
                        return nodes;
                    })}
                </AnimatePresence>
            </LayoutGroup>
        </p>
    );
}

type ItemProps = {
    itemKey: string;
    index: number;
    reduce: boolean;
    glue: string;
    /** The mark's identity, so it glides to whichever item carries it next. */
    glueId: string;
    children: ReactNode;
    ref?: Ref<HTMLSpanElement>;
};

function Item({ itemKey, index, reduce, glue, glueId, children, ref }: ItemProps) {
    const isPresent = useIsPresent();
    return (
        <motion.span
            // popLayout clones this element with a ref; it has to reach the DOM.
            ref={ref}
            data-part={itemKey}
            // inline-block: transforms don't apply to inline boxes, and popLayout
            // needs a measurable width to pin a leaving item.
            className="inline-block max-w-full whitespace-nowrap"
            // Position only: animating size would stretch the glyphs.
            layout="position"
            // A leaving item is out of the tab order and the accessibility tree at once.
            inert={!isPresent}
            aria-hidden={isPresent ? undefined : true}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6, y: "0.3em" }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={
                reduce
                    ? // Persisting words jump into the gap at once under reduced
                      // motion, so a slow fade would overlap them.
                      { opacity: 0, transition: { duration: 0 } }
                    : { opacity: 0, scale: 0.6, transition: exitTween }
            }
            // `layout` gets its own transition: a delay at the top level would also
            // hold back every persisting item's move.
            transition={{ layout: layoutSpring, default: { ...enterSpring, delay: reduce ? 0 : 0.05 + index * 0.02 } }}
        >
            {children}
            {glue && (
                // One identity per mark, even when the template moves it to another item.
                <motion.span layoutId={`glue:${glueId}`} className="inline-block" transition={{ layout: layoutSpring }}>
                    {glue}
                </motion.span>
            )}
        </motion.span>
    );
}
