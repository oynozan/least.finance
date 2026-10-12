import type { CSSProperties } from "react";
import Image from "next/image";

/** Any ticker. Ones without an official logo below get a plain, unbranded placeholder. */
export type CoinSymbol = string;

/**
 * The coins' official logos, from cryptologos.cc, in public/logos/coins.
 * Most are round coins already; `bare` ones are just the mark, so they sit on
 * a light disc to read as coins. Never draw a stand-in for a real logo.
 */
const LOGOS: Partial<Record<CoinSymbol, { bare?: true }>> = {
    BTC: {},
    ETH: { bare: true },
    SOL: { bare: true },
    USDC: {},
    USDT: { bare: true },
    BNB: {},
    LINK: { bare: true },
    DOGE: {},
    AVAX: {},
    ARB: {},
    XRP: { bare: true },
    OP: {},
};

type CoinIconProps = { symbol: CoinSymbol; className?: string; style?: CSSProperties };

/** A coin's logo, round, at whatever size `className` gives it. Decorative: its name is said beside it. */
export function CoinIcon({ symbol, className, style }: CoinIconProps) {
    const logo = LOGOS[symbol];
    const frame: CSSProperties = {
        display: "inline-grid",
        placeItems: "center",
        flexShrink: 0,
        borderRadius: "50%",
        overflow: "hidden",
        ...style,
    };
    if (!logo) {
        // No official logo here: a neutral disc with the ticker, not a stand-in.
        return (
            <span aria-hidden="true" className={className} style={{ ...frame, background: "#3a3a37" }}>
                <svg viewBox="0 0 32 32" style={{ width: "100%", height: "100%" }}>
                    <text x={16} y={16} dy="0.36em" textAnchor="middle" fill="#c8c8c3" fontSize={11} fontWeight={600}>
                        {symbol.slice(0, 4)}
                    </text>
                </svg>
            </span>
        );
    }
    return (
        <span aria-hidden="true" className={className} style={logo.bare ? { ...frame, background: "#f5f5f3" } : frame}>
            <Image
                src={`/logos/coins/${symbol}.svg`}
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
