import { useId, type JSX, type SVGProps } from "react";
import { networkName, type Network } from "@/lib/wallet/network";
import { ArcLogo } from "./icons";

type MarkProps = SVGProps<SVGSVGElement>;

// Simplified network marks in their brand colors, on the same 24×24 box as Arc's.

function Ethereum(props: MarkProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
            <path fill="#8c9ff1" d="M12 2 5.8 12.3 12 16l6.2-3.7z" />
            <path fill="#627eea" d="M12 2v14l6.2-3.7z" />
            <path fill="#8c9ff1" d="M12 17.2 5.8 13.5 12 22z" />
            <path fill="#627eea" d="M12 17.2V22l6.2-8.5z" />
        </svg>
    );
}

function BnbChain(props: MarkProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
            <g fill="#f0b90b">
                <path d="m12 8.6 3.4 3.4-3.4 3.4L8.6 12z" />
                <path d="m12 2 5.3 5.3-2 2L12 6 8.7 9.3l-2-2zM12 22l-5.3-5.3 2-2L12 18l3.3-3.3 2 2z" />
                <path d="m4.6 9.9 2.1 2.1-2.1 2.1L2.5 12zM19.4 9.9l2.1 2.1-2.1 2.1-2.1-2.1z" />
            </g>
        </svg>
    );
}

function Solana(props: MarkProps) {
    const id = useId();
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
            <defs>
                <linearGradient id={id} x1="4" y1="20" x2="20" y2="4" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#9945ff" />
                    <stop offset="1" stopColor="#14f195" />
                </linearGradient>
            </defs>
            <g fill={`url(#${id})`}>
                <path d="M6.4 15.6h14.1l-2.9 2.9H3.5z" />
                <path d="M6.4 5.5h14.1l-2.9 2.9H3.5z" />
                <path d="M17.6 10.6H3.5l2.9 2.9h14.1z" />
            </g>
        </svg>
    );
}

function Base(props: MarkProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
            <path fill="#0052ff" d="M12 21a9 9 0 1 0-8.96-9.8H15.1v1.6H3.04A9 9 0 0 0 12 21" />
        </svg>
    );
}

function Arbitrum(props: MarkProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
            <path fill="#213147" d="M12 2.2 20.5 7v10L12 21.8 3.5 17V7z" />
            <path stroke="#28a0f0" strokeWidth={1.8} strokeLinecap="round" d="m11.4 9.2 4.2 7.3M14 7.8l4.4 7.6" />
            <path stroke="#fff" strokeWidth={1.8} strokeLinecap="round" d="m10.2 7.8-4.5 7.8" />
        </svg>
    );
}

function Optimism(props: MarkProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
            <circle cx={12} cy={12} r={10} fill="#ff0420" />
            <text x={12} y={15.2} textAnchor="middle" fontSize={8.5} fontWeight={800} fill="#fff" fontFamily="inherit">
                OP
            </text>
        </svg>
    );
}

function Polygon(props: MarkProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
            <path
                stroke="#8247e5"
                strokeWidth={2}
                strokeLinejoin="round"
                d="M9.5 9.3 6.3 7.5 3 9.3v3.7l3.3 1.9 3.2-1.9V7.6l3.2-1.9L16 7.6M14.5 14.7l3.2 1.8L21 14.7V11l-3.3-1.9-3.2 1.9v5.4l-3.2 1.9L8 16.4"
            />
        </svg>
    );
}

function Avalanche(props: MarkProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
            <circle cx={12} cy={12} r={10} fill="#e84142" />
            <path fill="#fff" d="M12 6.6 7 15.8h3.1L12 12.3zM14.3 10.8l-2.7 5h5.4z" />
        </svg>
    );
}

/** Any other network, or none: a plain globe. */
function UnknownNetwork(props: MarkProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
            <g stroke="#8f8f8a" strokeWidth={1.6}>
                <circle cx={12} cy={12} r={8.5} />
                <path d="M3.5 12h17M12 3.5c-2.6 2.4-3.6 5.2-3.6 8.5s1 6.1 3.6 8.5M12 3.5c2.6 2.4 3.6 5.2 3.6 8.5s-1 6.1-3.6 8.5" />
            </g>
        </svg>
    );
}

const MARKS: Record<Network, (props: MarkProps) => JSX.Element> = {
    5042: ArcLogo,
    1: Ethereum,
    56: BnbChain,
    8453: Base,
    42161: Arbitrum,
    10: Optimism,
    137: Polygon,
    43114: Avalanche,
    solana: Solana,
};

/** The network's mark, named for screen readers. */
export function NetworkLogo({ network, className }: { network: Network | undefined; className?: string }) {
    const Mark = (network !== undefined && MARKS[network]) || UnknownNetwork;
    return <Mark className={className} role="img" aria-hidden={false} aria-label={networkName(network)} />;
}
