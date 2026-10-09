"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import NumberFlow from "@number-flow/react";
import { motion } from "motion/react";
import type { ChoiceSlotView, NumberSlotView } from "@/lib/sentence";
import { ChevronIcon } from "@/components/icons";
import { SentenceIcon } from "./icons";
import { layoutSpring, spring, typingLayout } from "./motion";
import { FloatingDialog } from "./dialog";
import { PillButton } from "./pill";
import { Picker } from "./picker";
import { Slider } from "./slider";

/** The pill's text; the short form replaces it on narrow screens. */
function Label({ label, short }: { label: string; short?: string }) {
    if (!short || short === label) return label;
    return (
        <>
            <span className="sm:hidden">{short}</span>
            <span className="hidden sm:inline">{label}</span>
        </>
    );
}

function Chevron({ open }: { open: boolean }) {
    return (
        <motion.span
            aria-hidden="true"
            className="mr-[0.32em] flex size-[0.42em] shrink-0 self-center text-muted"
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={spring}
        >
            <ChevronIcon className="size-full" />
        </motion.span>
    );
}

type ChoiceSlotProps = {
    view: Pick<ChoiceSlotView, "prompt" | "hint" | "value" | "selected" | "choices" | "issue" | "custom" | "wide">;
    /** The pill's accessible name when nothing is selected. */
    placeholder?: string;
    onChange: (value: string) => void;
};

/** A pill that opens a picker; its label changes only once a choice is made. */
export function ChoiceSlot({ view, placeholder = "pick one", onChange }: ChoiceSlotProps) {
    const [open, setOpen] = useState(false);
    const button = useRef<HTMLButtonElement>(null);
    const pickerId = useId();
    const hintId = useId();
    const wasOpen = useRef(false);

    // Focus returns to the pill after the commit, so its new name is already in place.
    useLayoutEffect(() => {
        if (wasOpen.current && !open) button.current?.focus({ preventScroll: true });
        wasOpen.current = open;
    }, [open]);

    const selected = view.selected && !view.selected.disabled ? view.selected : undefined;

    return (
        <>
            <PillButton
                ref={button}
                contentKey={selected?.value ?? "none"}
                icon={selected?.icon && <SentenceIcon icon={selected.icon} />}
                trailing={<Chevron open={open} />}
                tone={selected ? (selected.tone === "gain" || selected.tone === "loss" ? selected.tone : "default") : "muted"}
                aria-label={selected?.label ?? placeholder}
                aria-describedby={hintId}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? pickerId : undefined}
                onClick={() => setOpen(true)}
            >
                {selected ? <Label label={selected.label} short={selected.short} /> : placeholder}
            </PillButton>
            <span id={hintId} className="sr-only">
                {view.hint}
            </span>
            <Picker
                id={pickerId}
                open={open}
                title={view.prompt}
                choices={view.choices}
                selected={selected?.value}
                custom={view.custom}
                wide={view.wide}
                anchor={button}
                onSelect={(value) => {
                    onChange(value);
                    setOpen(false);
                }}
                onClose={() => setOpen(false)}
            />
        </>
    );
}

type NumberSlotProps = {
    view: NumberSlotView;
    onChange: (value: string) => void;
    /** Whether the amount is being edited (its dropdown is open). */
    onFocusChange?: (focused: boolean) => void;
    describedBy?: string;
};

const formats = new Map<string, Intl.NumberFormat>();
/** Grouped digits with up to `decimals` places; `compact` gives "10K". */
function formatNumber(value: number, decimals: number, compact = false) {
    const key = `${decimals}:${compact}`;
    let format = formats.get(key);
    if (!format) {
        format = new Intl.NumberFormat("en-US", {
            maximumFractionDigits: compact ? 1 : decimals,
            notation: compact ? "compact" : "standard",
        });
        formats.set(key, format);
    }
    return format.format(value);
}

/**
 * An amount pill whose digits roll as it changes. It drops down a field to
 * type into and a slider to drag, and the sentence follows both live.
 */
export function NumberSlot({ view, onChange, onFocusChange, describedBy }: NumberSlotProps) {
    const [open, setOpenState] = useState(false);
    const button = useRef<HTMLButtonElement>(null);
    const dropdownId = useId();
    const hintId = useId();
    const wasOpen = useRef(false);

    // Focus returns to the pill once the dropdown closes.
    useLayoutEffect(() => {
        if (wasOpen.current && !open) button.current?.focus({ preventScroll: true });
        wasOpen.current = open;
    }, [open]);

    const setOpen = (next: boolean) => {
        setOpenState(next);
        onFocusChange?.(next);
    };

    const invalid = view.issue?.severity === "error";
    const amount = Number(view.value) || 0;
    const shown = `${view.prefix ?? ""}${view.value || view.placeholder}${view.suffix ?? ""}`;

    return (
        <>
            <PillButton
                ref={button}
                contentKey="amount"
                layoutKey={formatNumber(amount, view.decimals)}
                layoutTransition={open ? typingLayout : layoutSpring}
                trailing={<Chevron open={open} />}
                tone={invalid ? "loss" : view.value ? "default" : "muted"}
                aria-label={shown}
                aria-describedby={[hintId, describedBy].filter(Boolean).join(" ")}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? dropdownId : undefined}
                aria-invalid={invalid}
                onClick={() => setOpen(true)}
            >
                {view.prefix && <span className="text-muted">{view.prefix}</span>}
                <NumberFlow value={amount} format={{ maximumFractionDigits: view.decimals }} willChange />
                {view.suffix && <span className="whitespace-pre text-muted">{view.suffix}</span>}
            </PillButton>
            <span id={hintId} className="sr-only">
                {view.hint}
            </span>
            <AmountDropdown
                id={dropdownId}
                open={open}
                anchor={button}
                view={view}
                onChange={onChange}
                onClose={() => setOpen(false)}
            />
        </>
    );
}

type AmountDropdownProps = {
    id: string;
    open: boolean;
    anchor: RefObject<HTMLElement | null>;
    view: NumberSlotView;
    onChange: (value: string) => void;
    onClose: () => void;
};

function AmountDropdown({ id, open, anchor, view, onChange, onClose }: AmountDropdownProps) {
    const titleId = useId();
    return (
        <FloatingDialog open={open} onClose={onClose} id={id} labelledBy={titleId} width={440} anchor={anchor}>
            <AmountPanel titleId={titleId} view={view} onChange={onChange} onClose={onClose} />
        </FloatingDialog>
    );
}

function AmountPanel({
    titleId,
    view,
    onChange,
    onClose,
}: Pick<AmountDropdownProps, "view" | "onChange" | "onClose"> & { titleId: string }) {
    const input = useRef<HTMLInputElement>(null);
    const slider = useRef<HTMLDivElement>(null);
    const invalid = view.issue?.severity === "error";
    const amount = Number(view.value) || 0;
    const { range } = view;
    const unit = (text: string) => `${view.prefix ?? ""}${text}${view.suffix ?? ""}`;

    // A mouse or keyboard goes straight to typing; touch starts on the
    // slider, so the keyboard doesn't cover it.
    useEffect(() => {
        if (window.matchMedia("(pointer: coarse)").matches) {
            slider.current?.focus({ preventScroll: true });
        } else {
            input.current?.focus({ preventScroll: true });
            input.current?.select();
        }
    }, []);

    return (
        <div className="flex flex-col">
            <p id={titleId} className="px-[18px] pt-2.5 pb-2 text-base font-medium tracking-[-0.01em] text-muted">
                {view.prompt}
            </p>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    onClose();
                }}
            >
                <label
                    className={`flex h-[76px] cursor-text items-center gap-3 rounded-[28px] bg-pill pr-6 pl-[22px] text-[34px] font-medium tracking-[-0.02em] ${
                        invalid ? "text-loss" : ""
                    }`}
                >
                    <span className="flex min-w-0 flex-1 items-baseline">
                        {view.prefix && <span className="text-muted">{view.prefix}</span>}
                        {/* The hidden copy sizes the input, so the unit sits right after the digits. */}
                        <span className="relative inline-block">
                            <span aria-hidden="true" className="invisible whitespace-pre">
                                {view.value || view.placeholder}
                            </span>
                            <input
                                ref={input}
                                type="text"
                                inputMode="decimal"
                                enterKeyHint="done"
                                autoComplete="off"
                                spellCheck={false}
                                aria-label={view.hint}
                                aria-invalid={invalid || undefined}
                                placeholder={view.placeholder}
                                value={view.value}
                                onChange={(event) => onChange(event.target.value)}
                                className="absolute top-0 left-0 h-full w-[calc(100%+2px)] border-0 bg-transparent p-0 text-inherit outline-none placeholder:text-muted"
                                style={{ font: "inherit", letterSpacing: "inherit" }}
                            />
                        </span>
                        {view.suffix && <span className="whitespace-pre text-muted">{view.suffix}</span>}
                    </span>
                    <span className="shrink-0 text-[15px] font-normal tracking-normal text-muted">type or drag</span>
                </label>
            </form>
            {range && (
                <div className="mt-2">
                    <Slider
                        ref={slider}
                        scale={range}
                        value={amount}
                        label={view.hint}
                        valueText={unit(formatNumber(amount, view.decimals))}
                        invalid={invalid}
                        onChange={(value) => onChange(String(value))}
                    />
                    {/* The ends stay on one line; the summary between them wraps if it must. */}
                    <div className="grid grid-cols-[auto_1fr_auto] items-baseline gap-3 px-[18px] pt-3 pb-2 text-[15px] leading-snug">
                        <span className="whitespace-nowrap text-muted">
                            {unit(formatNumber(range.min, view.decimals, true))}
                        </span>
                        <span className="text-center font-medium text-balance">{view.summary}</span>
                        <span className="text-right whitespace-nowrap text-muted">
                            {unit(formatNumber(range.max, view.decimals, !range.capped))}
                        </span>
                    </div>
                </div>
            )}
            {invalid && (
                <p className="px-[18px] pb-2 text-center text-[15px] leading-snug text-loss">{view.issue?.message}</p>
            )}
        </div>
    );
}
