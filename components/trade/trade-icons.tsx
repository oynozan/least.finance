import type { ReactNode } from "react";
import type { IconRef } from "@/lib/sentence";
import { CoinIcon } from "@/components/coin-icons";
import { NetworkLogo } from "@/components/network-icons";
import { logoNetwork, type NetworkId } from "@/lib/trade/networks";
import { MarketImage } from "./market-image";

// Flat marks with a white sticker ring, matching the original pill icons.
const RING = "rounded-full shadow-[0_0_0_0.07em_#fff]";

const GAIN = "#68d670";
const LOSS = "#ff6b5b";

const VERBS: Record<string, { fill: string; glyph: ReactNode }> = {
    swap: { fill: "#468df7", glyph: <path d="M9 12h14l-4-4M23 20H9l4 4" /> },
    buy: { fill: GAIN, glyph: <path d="M16 9v14M9 16h14" /> },
    sell: { fill: LOSS, glyph: <path d="M9 16h14" /> },
    long: { fill: GAIN, glyph: <path d="M9 21l5-5 4 4 6-7M19 13h5v5" /> },
    short: { fill: LOSS, glyph: <path d="M9 11l5 5 4-4 6 7M19 19h5v-5" /> },
    predict: {
        fill: "#a77bff",
        glyph: <path d="M12.5 12.5a3.5 3.5 0 1 1 5 3.2c-1 .5-1.5 1.2-1.5 2.3v.5M16 22.5v.5" />,
    },
};

const OUTCOMES: Record<string, ReactNode> = {
    yes: <path d="M10.5 16.5l3.5 3.5 7.5-8" />,
    no: <path d="M11.5 11.5l9 9M20.5 11.5l-9 9" />,
};

function Glyph({ fill, children }: { fill: string; children: ReactNode }) {
    return (
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={`size-[1.15em] ${RING}`}>
            <circle cx={16} cy={16} r={16} fill={fill} />
            <g stroke="#fff" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round">
                {children}
            </g>
        </svg>
    );
}

/** The network a badge names: a network itself, or a coin that carries one */
const networkOf = (badge: IconRef) => (badge.set === "network" ? badge : badge.badge);

const logoOf = (id: string) => logoNetwork(id as NetworkId);

/** How the trade domain draws each icon set the operations name. */
export function renderTradeIcon(icon: IconRef): ReactNode {
    switch (icon.set) {
        case "coin": {
            const coin = <CoinIcon symbol={icon.id} className={`size-[1.15em] ${RING}`} />;
            const badge = icon.badge && networkOf(icon.badge);
            if (!badge) return coin;
            return (
                <span className="relative flex shrink-0">
                    {coin}
                    {/* A sticker at the coin's corner, ringed in the surface the icon sits on. */}
                    <span
                        aria-hidden="true"
                        data-badge=""
                        className="absolute -right-[0.06em] -bottom-[0.06em] flex size-[0.5em] rounded-full shadow-[0_0_0_0.06em_var(--badge-ring,var(--pill))] transition-shadow duration-150"
                    >
                        <NetworkLogo network={logoOf(badge.id)} className="size-full" />
                    </span>
                </span>
            );
        }
        case "network":
            return <NetworkLogo network={logoOf(icon.id)} className="size-[1.15em]" />;
        case "verb": {
            const verb = VERBS[icon.id];
            return verb ? <Glyph fill={verb.fill}>{verb.glyph}</Glyph> : null;
        }
        case "outcome":
            return <Glyph fill={icon.tone === "loss" ? LOSS : GAIN}>{OUTCOMES[icon.id]}</Glyph>;
        case "image":
            return <MarketImage src={icon.id} />;
        default:
            return null;
    }
}
