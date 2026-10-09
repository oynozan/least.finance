"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { motion, useIsPresent, type Transition, type Variants } from "motion/react";
import type { Choice } from "@/lib/sentence";
import { CheckIcon } from "@/components/icons";
import { FloatingDialog } from "./dialog";
import { SentenceIcon } from "./icons";
import { panelSpring, wobble } from "./motion";

type PickerProps = {
    id: string;
    open: boolean;
    title: string;
    choices: readonly Choice[];
    selected?: string;
    /** Adds an input above the list for a value that isn't listed. */
    custom?: {
        placeholder: string;
        suffix?: string;
        parse: (text: string) => string | null;
    };
    /** Room for long labels: the panel widens and details go under the label. */
    wide?: boolean;
    onSelect: (value: string) => void;
    onClose: () => void;
};

const itemSpring: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.4 };

const listVariants: Variants = {
    hidden: {},
    shown: { transition: { staggerChildren: 0.03, delayChildren: 0.04 } },
};

const itemVariants: Variants = {
    hidden: { opacity: 0, y: 14, scale: 0.94 },
    shown: { opacity: 1, y: 0, scale: 1, transition: itemSpring },
};

const iconVariants: Variants = {
    rest: { scale: 1, rotate: 0 },
    active: { scale: 1.12, rotate: -10 },
};

const TONE = { gain: "text-gain", loss: "text-loss", neutral: "" } as const;

/** A centered, dropdown-style list of choices for one slot. */
export function Picker(props: PickerProps) {
    const titleId = useId();
    return (
        <FloatingDialog
            open={props.open}
            onClose={props.onClose}
            id={props.id}
            labelledBy={titleId}
            width={props.wide ? 640 : 440}
        >
            <Options {...props} titleId={titleId} />
        </FloatingDialog>
    );
}

function Options({ title, titleId, choices, selected, custom, wide, onSelect }: PickerProps & { titleId: string }) {
    const isPresent = useIsPresent();
    const base = useId();
    const listed = choices.findIndex((c) => c.value === selected);
    const [active, setActive] = useState(() => Math.max(listed, 0));
    const rows = useRef<(HTMLButtonElement | null)[]>([]);
    const input = useRef<HTMLInputElement>(null);
    const typed = useRef({ text: "", at: 0 });
    // A current value that isn't listed was typed: start in the input with it.
    const [text, setText] = useState(() => (custom && selected && listed < 0 ? selected : ""));
    const parsed = custom && text ? custom.parse(text) : null;
    const startInInput = !!custom && listed < 0 && !!selected;

    useEffect(() => {
        if (!isPresent) return;
        if (
            startInInput &&
            document.activeElement !== input.current &&
            !rows.current.includes(document.activeElement as HTMLButtonElement)
        ) {
            input.current?.focus({ preventScroll: true });
            return;
        }
        rows.current[active]?.focus({ preventScroll: true });
        rows.current[active]?.scrollIntoView({ block: "nearest" });
    }, [active, isPresent, startInInput]);

    // One highlight for the whole list, sliding to the active row's layout box
    // (offsetTop ignores the rows' entrance transforms).
    const [box, setBox] = useState<{ top: number; height: number } | null>(null);
    useLayoutEffect(() => {
        const row = rows.current[active];
        if (row) setBox({ top: row.offsetTop, height: row.offsetHeight });
    }, [active]);

    const onKeyDown = (event: KeyboardEvent) => {
        if (event.target === input.current) {
            if (event.key === "Enter") {
                event.preventDefault();
                if (parsed) onSelect(parsed);
            } else if (event.key === "ArrowDown") {
                event.preventDefault();
                rows.current[active]?.focus({ preventScroll: true });
            }
            return;
        }
        if (event.key === "ArrowUp" && active === 0 && custom) {
            event.preventDefault();
            input.current?.focus();
            return;
        }
        const last = choices.length - 1;
        const moves: Record<string, () => number> = {
            ArrowDown: () => (active === last ? 0 : active + 1),
            ArrowUp: () => (active === 0 ? last : active - 1),
            Home: () => 0,
            End: () => last,
        };
        if (moves[event.key]) {
            event.preventDefault();
            setActive(moves[event.key]());
            return;
        }
        // Typeahead: letters jump to the first choice that starts with them.
        if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey) {
            const now = event.timeStamp;
            typed.current = {
                text: (now - typed.current.at < 600 ? typed.current.text : "") + event.key.toLowerCase(),
                at: now,
            };
            const match = choices.findIndex((c) => c.label.toLowerCase().startsWith(typed.current.text));
            if (match >= 0) setActive(match);
        }
    };

    // Rows keep their order; a header starts each new group.
    const groups: { name?: string; items: { choice: Choice; index: number }[] }[] = [];
    choices.forEach((choice, index) => {
        const group = groups.at(-1);
        if (group && group.name === choice.group) group.items.push({ choice, index });
        else groups.push({ name: choice.group, items: [{ choice, index }] });
    });

    return (
        <div onKeyDown={onKeyDown} className="text-[clamp(24px,0.9rem+1.2vw,30px)]">
            <p id={titleId} className="px-[18px] pt-2.5 pb-2 text-base font-medium tracking-[-0.01em] text-muted">
                {title}
            </p>
            {custom && (
                <form
                    className="mb-1.5 flex items-center gap-2 rounded-full bg-pill py-1.5 pr-1.5 pl-5"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (parsed) onSelect(parsed);
                    }}
                >
                    <input
                        ref={input}
                        type="text"
                        inputMode="decimal"
                        enterKeyHint="done"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={custom.placeholder}
                        aria-invalid={(!!text && !parsed) || undefined}
                        placeholder={custom.placeholder}
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        // One size for the text and the placeholder, so the browser
                        // centers both in the field.
                        className={`h-11 min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-[20px] font-medium tracking-[-0.01em] outline-none placeholder:font-normal placeholder:text-muted ${
                            text && !parsed ? "text-loss" : "text-foreground"
                        }`}
                    />
                    {custom.suffix && text && <span className="text-[20px] text-muted">{custom.suffix}</span>}
                    <motion.button
                        type="submit"
                        aria-disabled={!parsed || undefined}
                        className={`h-11 shrink-0 rounded-full px-5 text-[16px] font-semibold outline-2 outline-offset-2 outline-transparent transition-colors focus-visible:outline-solid ${
                            parsed
                                ? "cursor-pointer bg-foreground text-background"
                                : "cursor-default bg-pill-hover text-muted"
                        }`}
                        whileTap={parsed ? { scale: 0.94 } : undefined}
                        transition={panelSpring}
                    >
                        Set
                    </motion.button>
                </form>
            )}
            <motion.div
                role="listbox"
                aria-labelledby={titleId}
                className="relative isolate flex flex-col gap-0.5"
                variants={listVariants}
                initial="hidden"
                animate="shown"
            >
                {/* Behind every row: rows sit on a higher layer, even while their
            entrance transforms make each one its own stacking context. */}
                {box && (
                    <motion.span
                        aria-hidden="true"
                        className={`pointer-events-none absolute inset-x-0 top-0 z-0 bg-pill-hover ${wide ? "rounded-[26px]" : "rounded-full"}`}
                        initial={{ opacity: 0, y: box.top, height: box.height }}
                        animate={{ opacity: 1, y: box.top, height: box.height }}
                        transition={{ ...panelSpring, opacity: { duration: 0.2, delay: 0.12 } }}
                    />
                )}
                {groups.map((group, g) => {
                    const headerId = `${base}-group-${g}`;
                    return (
                        <div
                            key={group.name ?? g}
                            role={group.name ? "group" : undefined}
                            aria-labelledby={group.name ? headerId : undefined}
                            className="flex flex-col gap-0.5"
                        >
                            {group.name && (
                                <p
                                    id={headerId}
                                    className="px-[18px] pt-3 pb-1 text-[13px] font-semibold tracking-[0.04em] text-muted uppercase"
                                >
                                    {group.name}
                                </p>
                            )}
                            {group.items.map(({ choice, index }) => {
                                const isActive = index === active;
                                const id = `${base}-${index}`;
                                const note = choice.disabled ?? choice.detail;
                                return (
                                    <motion.button
                                        key={choice.value}
                                        ref={(node) => {
                                            rows.current[index] = node;
                                        }}
                                        type="button"
                                        role="option"
                                        aria-selected={choice.value === selected}
                                        // Still focusable and in arrow order; the reason is read out.
                                        aria-disabled={choice.disabled ? true : undefined}
                                        aria-labelledby={`${id}-label`}
                                        aria-describedby={
                                            [choice.description && `${id}-description`, note && `${id}-note`]
                                                .filter(Boolean)
                                                .join(" ") || undefined
                                        }
                                        tabIndex={isActive ? 0 : -1}
                                        className={`relative z-10 flex w-full cursor-pointer items-center gap-[0.45em] py-[0.32em] pr-[0.5em] pl-[0.32em] text-left font-medium tracking-[-0.02em] outline-2 -outline-offset-2 outline-transparent focus-visible:outline-solid aria-disabled:cursor-default ${
                                            wide ? "rounded-[26px]" : "rounded-full"
                                        }`}
                                        variants={itemVariants}
                                        whileTap={choice.disabled ? undefined : { scale: 0.96 }}
                                        // Only a real pointer move picks a row: the panel springs in
                                        // under a resting pointer, and its rows sliding past would
                                        // otherwise steal the highlight from the selected one.
                                        onPointerMove={(event) => {
                                            if (event.movementX || event.movementY) setActive(index);
                                        }}
                                        onClick={() => {
                                            if (!choice.disabled) onSelect(choice.value);
                                        }}
                                    >
                                        {choice.icon && (
                                            <motion.span
                                                className={`relative z-10 flex shrink-0 select-none ${choice.disabled ? "opacity-40" : ""}`}
                                                variants={iconVariants}
                                                initial={false}
                                                animate={isActive && !choice.disabled ? "active" : "rest"}
                                                transition={wobble}
                                            >
                                                <SentenceIcon icon={choice.icon} />
                                            </motion.span>
                                        )}
                                        <span className="relative z-10 flex min-w-0 flex-1 flex-col">
                                            <span
                                                id={`${id}-label`}
                                                className={`leading-[1.2] text-balance ${choice.disabled ? "text-muted" : TONE[choice.tone ?? "neutral"]}`}
                                            >
                                                {choice.label}
                                            </span>
                                            {choice.description && (
                                                <span
                                                    id={`${id}-description`}
                                                    className="text-[15px] leading-snug font-normal text-muted"
                                                >
                                                    {choice.description}
                                                </span>
                                            )}
                                            {/* Wide pickers keep long labels on one line: details go below. */}
                                            {wide && note && (
                                                <span
                                                    id={`${id}-note`}
                                                    className="mt-0.5 text-[15px] leading-snug font-normal text-muted"
                                                >
                                                    {note}
                                                </span>
                                            )}
                                        </span>
                                        {!wide && note && (
                                            <span
                                                id={`${id}-note`}
                                                className="relative z-10 max-w-[45%] shrink-0 text-right text-[15px] leading-snug font-normal text-muted"
                                            >
                                                {note}
                                            </span>
                                        )}
                                        {choice.value === selected && (
                                            <motion.span
                                                className="relative z-10 flex size-[0.9em] shrink-0"
                                                initial={{ scale: 0, rotate: -45 }}
                                                animate={{ scale: 1, rotate: 0 }}
                                                transition={{ ...wobble, delay: 0.12 }}
                                            >
                                                <CheckIcon />
                                            </motion.span>
                                        )}
                                    </motion.button>
                                );
                            })}
                        </div>
                    );
                })}
            </motion.div>
        </div>
    );
}
