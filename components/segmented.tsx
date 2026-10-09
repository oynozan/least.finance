"use client";

import { useId, useRef, type KeyboardEvent } from "react";
import { motion, type Transition } from "motion/react";

const slide: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };

type SegmentedProps<T extends string> = {
    label: string;
    options: readonly { value: T; label: string }[];
    value: T;
    onChange: (value: T) => void;
};

/** A row of pill options; the chosen one's highlight slides between them. Arrow keys move it. */
export function Segmented<T extends string>({ label, options, value, onChange }: SegmentedProps<T>) {
    const id = useId();
    const buttons = useRef<(HTMLButtonElement | null)[]>([]);

    const onKeyDown = (event: KeyboardEvent) => {
        const at = options.findIndex((o) => o.value === value);
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (step === undefined) return;
        event.preventDefault();
        const next = (at + step + options.length) % options.length;
        onChange(options[next].value);
        buttons.current[next]?.focus();
    };

    return (
        <div role="radiogroup" aria-label={label} className="flex rounded-full bg-pill p-1" onKeyDown={onKeyDown}>
            {options.map((option, i) => {
                const checked = option.value === value;
                return (
                    <button
                        key={option.value}
                        ref={(node) => {
                            buttons.current[i] = node;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        tabIndex={checked ? 0 : -1}
                        className={`relative h-9 cursor-pointer rounded-full px-3.5 text-[14px] font-medium tracking-[-0.01em] outline-2 -outline-offset-2 outline-transparent transition-colors duration-200 focus-visible:outline-solid ${
                            checked ? "text-background" : "text-muted hover:text-foreground"
                        }`}
                        onClick={() => onChange(option.value)}
                    >
                        {checked && (
                            <motion.span
                                layoutId={`${id}-chosen`}
                                className="absolute inset-0 rounded-full bg-foreground"
                                transition={slide}
                            />
                        )}
                        <span className="relative">{option.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
