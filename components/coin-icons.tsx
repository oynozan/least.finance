import type { CSSProperties } from "react";
import Image from "next/image";

/** Any ticker. Ones without an official logo below get a plain, unbranded placeholder. */
export type CoinSymbol = string;

/**
 * The coins' official logos, in public/logos/coins. Most are round coins
 * already; `bare` ones are just the mark, so they sit on a light disc to read
 * as coins. `file` names the image when it isn't `<TICKER>.svg`: a logo too
 * heavy to ship as an SVG is the same artwork at 128 px in WebP. Never draw a
 * stand-in for a real logo; a coin without one gets the ticker placeholder.
 */
const LOGOS: Partial<Record<CoinSymbol, { bare?: true; file?: string }>> = {
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

    // The rest of the Hyperliquid perps, from cryptologos.cc.
    AAVE: {},
    ADA: { bare: true },
    ALGO: { bare: true },
    ALT: { bare: true },
    APE: {},
    APT: { bare: true },
    AR: { bare: true },
    ATOM: {},
    AXS: {},
    BCH: {},
    BOME: {},
    BONK: {},
    BRETT: { file: "BRETT.webp" },
    BSV: {},
    CAKE: { bare: true },
    CELO: {},
    CFX: { bare: true },
    COMP: {},
    CRV: { bare: true, file: "CRV.webp" },
    DASH: { bare: true },
    DOT: { bare: true },
    DYDX: {},
    EIGEN: {},
    ENA: {},
    ENS: { bare: true },
    ETC: { bare: true },
    ETHFI: {},
    FET: { bare: true },
    FIL: {},
    FLOKI: { bare: true },
    GALA: { bare: true },
    GAS: { bare: true },
    GOAT: { file: "GOAT.webp" },
    HBAR: {},
    ICP: { bare: true },
    IMX: { bare: true },
    INJ: { bare: true },
    IOTA: { bare: true },
    JUP: {},
    KAS: {},
    LDO: {},
    LTC: {},
    MEME: {},
    MINA: {},
    MNT: {},
    NEAR: { bare: true },
    NEO: { bare: true },
    ONDO: { bare: true },
    ORDI: {},
    PAXG: { bare: true },
    PENDLE: {},
    PEPE: {},
    POL: { bare: true }, // cryptologos.cc files Polygon's logo under MATIC
    POPCAT: { bare: true },
    PYTH: {},
    RSR: {},
    RUNE: { bare: true },
    SAND: {},
    SEI: { bare: true },
    SHIB: {},
    SNX: {},
    STRK: {},
    STX: {},
    SUI: { bare: true },
    SUPER: {},
    SUSHI: { bare: true },
    TAO: { bare: true },
    TIA: {},
    TRB: {},
    TRX: { bare: true },
    UMA: { bare: true },
    UNI: { bare: true },
    VIRTUAL: { bare: true },
    W: { bare: true },
    WIF: {},
    WLD: { bare: true },
    XLM: { bare: true },
    XMR: {},
    ZEC: {},

    // From Hyperliquid's own icons (app.hyperliquid.xyz/coins/<NAME>.svg), where cryptologos.cc has none.
    "0G": { bare: true },
    ACE: { bare: true },
    AERO: { file: "AERO.webp" },
    AIXBT: {},
    ANIME: {},
    APEX: { bare: true },
    ASTER: {},
    AVNT: {},
    AZTEC: {},
    BABY: {},
    BANANA: {},
    BERA: {},
    BIGTIME: { bare: true },
    BIO: {},
    BLUR: {},
    CASHCAT: { bare: true, file: "CASHCAT.webp" },
    CC: { bare: true },
    CHIP: {},
    DYM: { bare: true },
    FARTCOIN: {},
    FOGO: {},
    GMT: {},
    GMX: {},
    GRAM: {},
    GRASS: {},
    GRIFFAIN: {},
    HEMI: { bare: true },
    HMSTR: { file: "HMSTR.webp" },
    HYPE: {},
    HYPER: {},
    INIT: {},
    IO: {},
    JTO: {},
    KAITO: {},
    LAYER: {},
    LINEA: {},
    LIT: {},
    LUNC: { bare: true },
    MANTA: { bare: true },
    ME: {},
    MEGA: { bare: true },
    MELANIA: { file: "MELANIA.webp" },
    MERL: {},
    MET: { bare: true },
    MON: { bare: true },
    MOODENG: { file: "MOODENG.webp" },
    MORPHO: {},
    MOVE: {},
    NEIRO: { file: "NEIRO.webp" },
    NIL: { bare: true },
    NOT: {},
    NXPC: {},
    PENGU: {},
    PNUT: { file: "PNUT.webp" },
    POLYX: {},
    PONS: { bare: true },
    PROVE: {},
    PUMP: {},
    PURR: {},
    RENDER: {},
    RESOLV: {},
    REZ: {},
    S: {},
    SAGA: {},
    SKR: {},
    SKY: {},
    SOPH: {},
    SPX: {},
    STABLE: {},
    STBL: { bare: true },
    SYRUP: {},
    TNSR: {},
    TRUMP: {},
    TURBO: {},
    USELESS: {},
    USUAL: { file: "USUAL.webp" },
    VVV: {},
    WCT: {},
    WLFI: { bare: true },
    XAI: {},
    XPL: {},
    YGG: {},
    ZEN: { file: "ZEN.webp" },
    ZETA: {},
    ZK: {},
    ZORA: {},
    ZRO: {},
};

type CoinIconProps = { symbol: CoinSymbol; className?: string; style?: CSSProperties };

/**
 * A coin's logo, round, at whatever size `className` gives it. Decorative: its name is said beside it.
 * A k-asset (kPEPE is 1,000 PEPE) shows its base coin's logo.
 */
export function CoinIcon({ symbol, className, style }: CoinIconProps) {
    const base = symbol.replace(/^k(?=[A-Z])/, "");
    const logo = LOGOS[base];
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
                        {base.slice(0, 4)}
                    </text>
                </svg>
            </span>
        );
    }
    return (
        <span aria-hidden="true" className={className} style={logo.bare ? { ...frame, background: "#f5f5f3" } : frame}>
            <Image
                src={`/logos/coins/${logo.file ?? `${base}.svg`}`}
                alt=""
                width={64}
                height={64}
                unoptimized
                loading="lazy"
                draggable={false}
                style={{ width: logo.bare ? "62%" : "100%", height: logo.bare ? "62%" : "100%", objectFit: "contain" }}
            />
        </span>
    );
}
