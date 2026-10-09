import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

// Sticker-style icons: the white stroke is drawn underneath the fill, so the
// outline only grows outward.

export function CheckIcon(props: IconProps) {
    return (
        <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
            <circle cx={32} cy={32} r={24} stroke="#fff" strokeWidth={8} />
            <circle cx={32} cy={32} r={24} fill="#68d670" />
            <path d="M21 33l7.5 7.5L44 25" stroke="#fff" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function ChevronIcon(props: IconProps) {
    return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
            <path
                d="M3.5 6 8 10.5 12.5 6"
                stroke="currentColor"
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

const line = {
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
} as const;

export function PlusIcon(props: IconProps) {
    return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
            <path d="M8 3v10M3 8h10" {...line} strokeWidth={2.2} />
        </svg>
    );
}

export function CloseIcon(props: IconProps) {
    return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
            <path d="M4 4l8 8M12 4l-8 8" {...line} />
        </svg>
    );
}

export function PowerIcon(props: IconProps) {
    return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
            <path d="M8 2.5V8M4.7 4.6a5 5 0 1 0 6.6 0" {...line} />
        </svg>
    );
}
