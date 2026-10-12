import type { CSSProperties, SVGProps } from "react";
import Image from "next/image";
import { networkName, type Network } from "@/lib/wallet/network";
import { ArcLogo } from "./icons";

/**
 * The networks' official logos, from cryptologos.cc, in public/logos/networks.
 * `bare` ones are just the mark, so they sit on a light disc. Arc isn't on
 * cryptologos: its official mark is ArcLogo, and Base's square is from Base's
 * brand kit. Never draw a stand-in for a real logo.
 */
const LOGOS: Partial<Record<Network, { file: string; bare?: true }>> = {
    1: { file: "ethereum", bare: true },
    56: { file: "bnb-chain" },
    8453: { file: "base", bare: true },
    42161: { file: "arbitrum" },
    10: { file: "optimism" },
    137: { file: "polygon", bare: true },
    43114: { file: "avalanche" },
    solana: { file: "solana", bare: true },
};

const ARC = 5042;

/** Any other network, or none: a plain globe, not anyone's logo. */
function UnknownNetwork(props: SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="none" {...props}>
            <g stroke="#8f8f8a" strokeWidth={1.6}>
                <circle cx={12} cy={12} r={8.5} />
                <path d="M3.5 12h17M12 3.5c-2.6 2.4-3.6 5.2-3.6 8.5s1 6.1 3.6 8.5M12 3.5c2.6 2.4 3.6 5.2 3.6 8.5s-1 6.1-3.6 8.5" />
            </g>
        </svg>
    );
}

const frame: CSSProperties = {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    borderRadius: "50%",
    overflow: "hidden",
};

/** The network's logo, round, named for screen readers. */
export function NetworkLogo({ network, className }: { network: Network | undefined; className?: string }) {
    const label = networkName(network);
    if (network === ARC) {
        // Arc's white mark, on black.
        return (
            <span role="img" aria-label={label} className={className} style={{ ...frame, background: "#000" }}>
                <ArcLogo style={{ width: "66%", height: "66%" }} />
            </span>
        );
    }
    const logo = network !== undefined ? LOGOS[network] : undefined;
    if (!logo) return <UnknownNetwork role="img" aria-label={label} className={className} />;
    return (
        <span
            role="img"
            aria-label={label}
            className={className}
            style={logo.bare ? { ...frame, background: "#f5f5f3" } : frame}
        >
            <Image
                src={`/logos/networks/${logo.file}.svg`}
                alt=""
                width={64}
                height={64}
                unoptimized
                loading="eager"
                draggable={false}
                style={{ width: logo.bare ? "62%" : "100%", height: logo.bare ? "62%" : "100%", objectFit: "contain" }}
            />
        </span>
    );
}
