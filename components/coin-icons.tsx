import type { CSSProperties } from "react";
import Image from "next/image";
import { baseTicker, coinLogoBase } from "@/lib/coin-logo/symbol";
import { RemoteCoinIcon } from "./remote-coin-icon";

/** Any ticker. Ones without a logo below ask /coin-logo for one, and show a plain, unbranded placeholder until it comes. */
export type CoinSymbol = string;

/**
 * The coins' official logos, from cryptologos.cc, in public/logos/coins: the few the app shows everywhere.
 * Most are round coins already; `bare` ones are just the mark, so they sit on
 * a light disc to read as coins. Every other coin's logo comes from /coin-logo.
 * Never draw a stand-in for a real logo.
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

/**
 * A coin's logo, round, at whatever size `className` gives it. Decorative: its name is said beside it.
 * A k-asset (kPEPE is 1,000 PEPE) shows its base coin's logo.
 */
export function CoinIcon({ symbol, className, style }: CoinIconProps) {
    const base = baseTicker(symbol);
    const logo = LOGOS[base];
    const frame: CSSProperties = {
        display: "inline-grid",
        placeItems: "center",
        flexShrink: 0,
        borderRadius: "50%",
        overflow: "hidden",
        ...style,
    };
    if (!logo) return <RemoteCoinIcon ticker={base} logo={coinLogoBase(symbol)} className={className} style={style} />;
    return (
        <span aria-hidden="true" className={className} style={logo.bare ? { ...frame, background: "#f5f5f3" } : frame}>
            <Image
                src={`/logos/coins/${base}.svg`}
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
