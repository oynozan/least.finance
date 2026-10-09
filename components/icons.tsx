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

/** Arc's mark, white on a transparent ground. */
export function ArcLogo(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
            <path
                fill="#fff"
                d="M3.5 20.999c.146-4.407.893-8.519 2.142-11.717C7.223 5.231 9.513 3 12.088 3s4.865 2.231 6.447 6.283c.822 2.107 1.427 4.61 1.786 7.334q.048.366.087.737.015.024.013.041s.21 1.317.256 3.604h-.024c-.313-.256-4-3.153-10.112-2.314.093-1.035.22-2.04.383-3.005l.027-.146a24.5 24.5 0 0 1 6.104.57q-.007-.056-.017-.115c-.33-2.06-.819-3.945-1.448-5.556-1.029-2.635-2.371-4.271-3.502-4.271-1.132 0-2.474 1.636-3.503 4.271q-.375.958-.679 2.034a30 30 0 0 0-.718 3.213A40 40 0 0 0 6.662 21H3.5z"
            />
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
