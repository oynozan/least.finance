"use client";

import {
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type RefObject,
} from "react";
import { motion, useIsPresent, type Transition, type Variants } from "motion/react";
import type { Choice } from "@/lib/sentence";
import { CheckIcon, ChevronIcon } from "@/components/icons";
import { FloatingDialog } from "./dialog";
import { SentenceIcon } from "./icons";
import { panelSpring, wobble } from "./motion";

type PickerProps = {
    id: string;
    open: boolean;
    /** Shown above the list; without it the list starts at the top. */
    title?: string;
    /** The dialog's name for screen readers when it has no title. */
    label: string;
    choices: readonly Choice[];
    /** The host is still fetching the choices, so skeleton rows stand in for the list. */
    loading?: boolean;
    selected?: string;
    /** Adds an input above the list for a value that isn't listed. */
    custom?: {
        placeholder: string;
        suffix?: string;
        parse: (text: string) => string | null;
    };
    /** Adds a search field above the list; the host answers `onQuery` by changing `choices`. */
    search?: {
        placeholder: string;
        /** The host filters its own list, so each keystroke starts the highlight at the top. */
        local?: boolean;
        onQuery: (query: string) => void;
        /** Said above the list when the search found nothing. */
        empty?: string;
    };
    /** Room for long labels: the panel widens and details go under the label. */
    wide?: boolean;
    /** Said under the title while the slot has a problem, with the way out */
    notice?: string;
    /** Said under the title when there are no choices. */
    empty?: string;
    /** A second step for a picked row, its follow-up choices (a coin's networks) replacing the list; for pickers with no search or custom input. */
    then?: {
        /** Shown above the second step's list; without it the label is used. */
        title?: string;
        /** The second step's name for screen readers when it has no title. */
        label: string;
        /** The follow-up choices as they would be were the host set to this value. */
        choicesFor: (host: string) => readonly Choice[];
        selected?: string;
        /** A row with follow-ups was picked: the host commits it at once, then the second step shows. */
        onPick: (host: string) => void;
        onSelect: (value: string) => void;
    };
    /** The pill it drops down from. */
    anchor?: RefObject<HTMLElement | null>;
    onSelect: (value: string) => void;
    onClose: () => void;
};

const itemSpring: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.4 };

/** Rows come in 30ms apart, but a long list takes 0.4s in all. */
const listVariants = (rows: number): Variants => ({
    hidden: {},
    shown: { transition: { staggerChildren: Math.min(0.03, 0.4 / Math.max(rows, 1)), delayChildren: 0.04 } },
});

const itemVariants: Variants = {
    hidden: { opacity: 0, y: 14, scale: 0.94 },
    shown: { opacity: 1, y: 0, scale: 1, transition: itemSpring },
};

const iconVariants: Variants = {
    rest: { scale: 1, rotate: 0 },
    active: { scale: 1.12, rotate: -10 },
};

const TONE = { gain: "text-gain", loss: "text-loss", neutral: "" } as const;

/** Rows sit 10px inside the panel's 34px corners (dialog.tsx), so their corners follow it at 34 - 10. */
const ROW_RADIUS = "rounded-[24px]";

/** The skeleton's label widths, so its rows don't read as one block. */
const SKELETON_WIDTHS = [72, 54, 66, 48, 60];

/** A dropdown list of choices for one slot, dropped from its pill. */
export function Picker(props: PickerProps) {
    const titleId = useId();
    return (
        <FloatingDialog
            open={props.open}
            onClose={props.onClose}
            id={props.id}
            labelledBy={titleId}
            width={props.wide ? 640 : 440}
            anchor={props.anchor}
        >
            <Options {...props} titleId={titleId} />
        </FloatingDialog>
    );
}

function Options({
    title,
    label,
    titleId,
    choices,
    loading,
    selected,
    custom,
    search,
    wide,
    notice,
    empty,
    then,
    onSelect,
}: PickerProps & { titleId: string }) {
    const isPresent = useIsPresent();
    const base = useId();
    // The row picked on the first step while its follow-ups are on show
    const [host, setHost] = useState<string | null>(null);
    const followUps = then?.choicesFor;
    const second = useMemo(() => (host !== null && followUps ? followUps(host) : null), [host, followUps]);
    const step = second ? 1 : 0;
    const shown = second ?? choices;
    const list = useMemo(() => listVariants(shown.length), [shown.length]);
    const shownSelected = second ? then?.selected : selected;
    const listed = shown.findIndex((c) => c.value === shownSelected);
    const selectedAt = choices.findIndex((c) => c.value === selected);
    // Null follows the selected row; the arrow keys and the pointer set a row of their own.
    const [wanted, setActive] = useState<number | null>(() => Math.max(selectedAt, 0));
    // A new search can shorten the list under the active row.
    const active = Math.max(0, Math.min(wanted ?? listed, shown.length - 1));
    const root = useRef<HTMLDivElement>(null);
    const backButton = useRef<HTMLButtonElement>(null);
    const field = useRef<HTMLInputElement>(null);
    // Whether the search field is where focus belongs; arrow keys hand it to the list and back.
    const inField = useRef(true);
    const hasSearch = !!search;
    const onQuery = useRef(search?.onQuery);
    useEffect(() => {
        onQuery.current = search?.onQuery;
    });
    const [query, setQuery] = useState("");
    const left = useRef(false);
    // Closing ends the search, so the next opening lists the trending questions.
    // Reopening during the exit animation revives this panel, so it resets then.
    useEffect(() => {
        if (!isPresent) {
            left.current = true;
            inField.current = true;
            onQuery.current?.("");
        } else if (left.current) {
            left.current = false;
            setQuery("");
            onQuery.current?.("");
            setHost(null);
            setActive(null);
        }
    }, [isPresent]);
    useEffect(
        () => () => {
            onQuery.current?.("");
        },
        [],
    );
    const rows = useRef<HTMLButtonElement[]>([]);
    // Read from the page after every commit: a row that outlives a filter keeps its element but takes a new place in the list.
    useLayoutEffect(() => {
        rows.current = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    });
    const input = useRef<HTMLInputElement>(null);
    const typed = useRef({ text: "", at: 0 });
    // A current value that isn't listed was typed: start in the input with it.
    const [text, setText] = useState(() => (custom && selected && selectedAt < 0 ? selected : ""));
    const parsed = custom && text ? custom.parse(text) : null;
    const startInInput = !!custom && selectedAt < 0 && !!selected;

    // Each step starts at the top of the panel, where its title and Back are.
    useLayoutEffect(() => {
        root.current?.closest("[data-floating-dialog]")?.scrollTo({ top: 0 });
    }, [step]);

    useEffect(() => {
        if (!isPresent) return;
        if (hasSearch && inField.current) {
            field.current?.focus({ preventScroll: true });
            return;
        }
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
    }, [active, isPresent, startInInput, hasSearch, second]);

    // One highlight for the whole list, sliding to the active row's layout box
    // (offsetTop ignores the rows' entrance transforms). Each step has a list of its own.
    const [box, setBox] = useState<{ step: number; top: number; height: number } | null>(null);
    useLayoutEffect(() => {
        const row = rows.current[active];
        if (row) setBox({ step, top: row.offsetTop, height: row.offsetHeight });
    }, [active, shown, step, search?.empty, loading]);

    // A row with follow-ups commits at once and goes on to them; any other row is the answer.
    const choose = (value: string) => {
        if (then && then.choicesFor(value).length > 1) {
            then.onPick(value);
            setHost(value);
            setActive(null);
        } else onSelect(value);
    };
    const goBack = () => {
        setHost(null);
        setActive(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
        if (event.target === backButton.current) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                rows.current[active]?.focus({ preventScroll: true });
            }
            return;
        }
        if (event.target === field.current) {
            if (event.key === "ArrowDown" && choices.length > 0 && !loading) {
                event.preventDefault();
                inField.current = false;
                rows.current[active]?.focus({ preventScroll: true });
            }
            return;
        }
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
        if (event.key === "ArrowUp" && active === 0 && second) {
            event.preventDefault();
            backButton.current?.focus();
            return;
        }
        if (event.key === "ArrowUp" && active === 0 && (search || custom)) {
            event.preventDefault();
            inField.current = !!search;
            (search ? field : input).current?.focus();
            return;
        }
        const last = shown.length - 1;
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
        if (!search && event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey) {
            const now = event.timeStamp;
            typed.current = {
                text: (now - typed.current.at < 600 ? typed.current.text : "") + event.key.toLowerCase(),
                at: now,
            };
            const match = shown.findIndex((c) => c.label.toLowerCase().startsWith(typed.current.text));
            if (match >= 0) setActive(match);
        }
    };

    // Rows keep their order; a header starts each new group.
    const groups: { name?: string; items: { choice: Choice; index: number }[] }[] = [];
    shown.forEach((choice, index) => {
        const group = groups.at(-1);
        if (group && group.name === choice.group) group.items.push({ choice, index });
        else groups.push({ name: choice.group, items: [{ choice, index }] });
    });

    return (
        <div
            ref={root}
            onKeyDown={onKeyDown}
            // The network badges on the rows are ringed in the panel's colour.
            className="text-[clamp(24px,0.9rem+1.2vw,30px)] [--badge-ring:var(--panel)]"
        >
            <div className={second ? "flex items-center gap-2 pt-1 pb-1.5" : undefined}>
                {second && (
                    <button
                        ref={backButton}
                        type="button"
                        className="flex h-9 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-pill pr-3.5 pl-2.5 text-base font-medium tracking-[-0.01em] text-muted outline-2 -outline-offset-2 outline-transparent transition-colors hover:bg-pill-hover hover:text-foreground focus-visible:bg-pill-hover focus-visible:text-foreground focus-visible:outline-solid"
                        onClick={goBack}
                    >
                        <ChevronIcon className="size-3.5 rotate-90" />
                        Back
                    </button>
                )}
                <p
                    id={titleId}
                    className={
                        second
                            ? "text-base font-medium tracking-[-0.01em] text-muted"
                            : title
                              ? "px-[18px] pt-2.5 pb-2 text-base font-medium tracking-[-0.01em] text-muted"
                              : "sr-only"
                    }
                >
                    {second ? (then?.title ?? then?.label) : (title ?? label)}
                </p>
            </div>
            {notice && !second && <p className="px-[18px] pb-2 text-[15px] leading-snug text-loss">{notice}</p>}
            {empty && !loading && choices.length === 0 && (
                <p className="px-[18px] pb-3 text-base tracking-[-0.01em] text-muted">{empty}</p>
            )}
            {search && (
                <input
                    ref={field}
                    type="search"
                    enterKeyHint="search"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={search.placeholder}
                    placeholder={search.placeholder}
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        if (search.local) setActive(0);
                        search.onQuery(event.target.value);
                    }}
                    className="mb-1.5 h-11 w-full rounded-full border-0 bg-pill px-[18px] font-sans text-[20px] font-medium tracking-[-0.01em] text-foreground outline-none placeholder:font-normal placeholder:text-muted"
                />
            )}
            {search?.empty && !loading && (
                <p className="px-[18px] pb-2 text-base tracking-[-0.01em] text-muted">{search.empty}</p>
            )}
            {custom && (
                <form
                    className="mb-1.5 flex items-center gap-2 rounded-full bg-pill py-1.5 pr-1.5 pl-[18px]"
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
            {loading ? (
                <Skeleton wide={wide} />
            ) : (
                <motion.div
                    key={step}
                    role="listbox"
                    aria-labelledby={titleId}
                    className="relative isolate flex flex-col gap-0.5"
                    variants={list}
                    initial="hidden"
                    animate="shown"
                >
                    {/* The bottom layer of the list: a negative z-index inside the
            isolated listbox paints below everything else in it, group
            headers and labels included, wherever the highlight slides. */}
                    {box?.step === step && shown.length > 0 && (
                        <motion.span
                            aria-hidden="true"
                            data-highlight=""
                            className={`pointer-events-none absolute inset-x-0 top-0 -z-10 bg-pill-hover ${ROW_RADIUS}`}
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
                                    // A held amount reads as the deposit list's does: the amount over its value.
                                    const sub = choice.disabled ? undefined : choice.subdetail;
                                    return (
                                        <motion.button
                                            key={choice.value}
                                            type="button"
                                            role="option"
                                            aria-selected={choice.value === shownSelected}
                                            // Still focusable and in arrow order; the reason is read out.
                                            aria-disabled={choice.disabled ? true : undefined}
                                            aria-labelledby={`${id}-label`}
                                            aria-describedby={
                                                [
                                                    choice.description && `${id}-description`,
                                                    note && `${id}-note`,
                                                    sub && `${id}-sub`,
                                                ]
                                                    .filter(Boolean)
                                                    .join(" ") || undefined
                                            }
                                            tabIndex={isActive ? 0 : -1}
                                            className={`relative z-10 flex w-full cursor-pointer items-center gap-[0.45em] px-[18px] py-[0.32em] text-left font-medium tracking-[-0.02em] outline-2 -outline-offset-2 outline-transparent focus-visible:outline-solid aria-disabled:cursor-default ${ROW_RADIUS}`}
                                            variants={itemVariants}
                                            whileTap={choice.disabled ? undefined : { scale: 0.96 }}
                                            // Only a real pointer move picks a row: the panel springs in
                                            // under a resting pointer, and its rows sliding past would
                                            // otherwise steal the highlight from the selected one.
                                            onPointerMove={(event) => {
                                                if (event.movementX || event.movementY) setActive(index);
                                            }}
                                            onClick={() => {
                                                if (choice.disabled) return;
                                                if (second) then?.onSelect(choice.value);
                                                else choose(choice.value);
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
                                                {wide && sub && (
                                                    <span
                                                        id={`${id}-sub`}
                                                        className="text-[15px] leading-snug font-normal text-muted"
                                                    >
                                                        {sub}
                                                    </span>
                                                )}
                                            </span>
                                            {!wide && note && (
                                                <span
                                                    className={`relative z-10 flex max-w-[45%] shrink-0 flex-col items-end text-right leading-snug font-normal ${
                                                        sub ? "tabular-nums" : ""
                                                    }`}
                                                >
                                                    <span
                                                        id={`${id}-note`}
                                                        className={`text-[15px] ${sub ? "font-medium text-foreground" : "text-muted"}`}
                                                    >
                                                        {note}
                                                    </span>
                                                    {sub && (
                                                        <span id={`${id}-sub`} className="text-[13px] text-muted">
                                                            {sub}
                                                        </span>
                                                    )}
                                                </span>
                                            )}
                                            {/* The check's room is kept on every row, so picking one never reflows its label. */}
                                            {choice.value === shownSelected ? (
                                                <motion.span
                                                    className="relative z-10 flex size-[0.9em] shrink-0"
                                                    initial={{ scale: 0, rotate: -45 }}
                                                    animate={{ scale: 1, rotate: 0 }}
                                                    transition={{ ...wobble, delay: 0.12 }}
                                                >
                                                    <CheckIcon />
                                                </motion.span>
                                            ) : (
                                                <span aria-hidden="true" className="size-[0.9em] shrink-0" />
                                            )}
                                        </motion.button>
                                    );
                                })}
                            </div>
                        );
                    })}
                </motion.div>
            )}
        </div>
    );
}

/** Rows shaped like the list's, pulsing while it loads. */
function Skeleton({ wide }: { wide?: boolean }) {
    return (
        <div role="status" className="flex flex-col gap-0.5">
            <span className="sr-only">Loading</span>
            {SKELETON_WIDTHS.map((width, i) => (
                <div key={i} aria-hidden="true" className="flex items-center gap-[0.45em] px-[18px] py-[0.32em]">
                    <span className="size-[1.15em] shrink-0 animate-pulse rounded-full bg-pill motion-reduce:animate-none" />
                    <span className="flex min-w-0 flex-1 flex-col gap-2 py-[0.1em]">
                        <span
                            className="h-[0.6em] animate-pulse rounded-full bg-pill motion-reduce:animate-none"
                            style={{ width: `${width}%` }}
                        />
                        {wide && (
                            <span className="h-[15px] w-[34%] animate-pulse rounded-full bg-pill motion-reduce:animate-none" />
                        )}
                    </span>
                </div>
            ))}
        </div>
    );
}
