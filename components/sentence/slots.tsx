"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import type { ChoiceSlotView, NumberSlotView } from "@/lib/sentence";
import { ChevronIcon } from "@/components/icons";
import { SentenceIcon } from "./icons";
import { layoutSpring, spring, typingLayout } from "./motion";
import { PillBody, PillButton } from "./pill";
import { Picker } from "./picker";

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
                tone={selected ? (selected.tone === "loss" ? "loss" : "default") : "muted"}
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
    onFocusChange?: (focused: boolean) => void;
    describedBy?: string;
};

/** An amount typed straight into the sentence; the pill grows with the digits. */
export function NumberSlot({ view, onChange, onFocusChange, describedBy }: NumberSlotProps) {
    const [focused, setFocused] = useState(false);
    // Always exactly what was typed: reformatting on focus or blur would reset
    // the caret and selection under the user's fingers.
    const shown = view.value;
    const invalid = view.issue?.severity === "error";

    return (
        <label
            className={`group inline-flex max-w-full cursor-text ${invalid ? "text-loss" : ""}`}
            onPointerDown={(event) => {
                // A tap anywhere on the pill (the unit too) edits the amount.
                if (event.target !== event.currentTarget.querySelector("input")) {
                    event.preventDefault();
                    event.currentTarget.querySelector("input")?.focus();
                }
            }}
        >
            <PillBody
                contentKey="amount"
                layoutTransition={focused ? typingLayout : layoutSpring}
                className="group-hover:bg-pill-hover group-focus-within:bg-pill-hover"
            >
                <span className="inline-flex items-baseline">
                    {view.prefix && <span className="text-muted">{view.prefix}</span>}
                    {/* The hidden copy sets the width and the input lies over it, so
                        the input's own intrinsic width, which each engine sizes
                        differently, never stretches or squeezes the pill. */}
                    <span className="relative inline-block">
                        <span aria-hidden="true" className="invisible whitespace-pre">
                            {shown || view.placeholder}
                        </span>
                        <input
                            type="text"
                            inputMode="decimal"
                            enterKeyHint="done"
                            autoComplete="off"
                            spellCheck={false}
                            aria-label={view.prompt}
                            aria-describedby={describedBy}
                            aria-invalid={invalid || undefined}
                            placeholder={view.placeholder}
                            value={shown}
                            onChange={(event) => onChange(event.target.value)}
                            onFocus={() => {
                                setFocused(true);
                                onFocusChange?.(true);
                            }}
                            onBlur={() => {
                                setFocused(false);
                                onFocusChange?.(false);
                            }}
                            // 2px past the copy holds the caret at the end; WebKit
                            // would otherwise scroll the digits to show it.
                            className="absolute top-0 left-0 h-full w-[calc(100%+2px)] border-0 bg-transparent p-0 text-inherit outline-none placeholder:text-muted"
                            style={{ font: "inherit", letterSpacing: "inherit" }}
                        />
                    </span>
                    {view.suffix && <span className="whitespace-pre text-muted">{view.suffix}</span>}
                </span>
            </PillBody>
        </label>
    );
}
