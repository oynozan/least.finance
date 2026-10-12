import { useId, type JSX, type SVGProps } from "react";

/** Any ticker. Ones without a bespoke mark below get a lettered coin. */
export type CoinSymbol = string;

type IconProps = SVGProps<SVGSVGElement>;

// Flat 32×32 coin marks, drawn simply enough to read at 20px.

function Coin({ fill, children, ...props }: IconProps & { fill: string }) {
    return (
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
            <circle cx={16} cy={16} r={16} fill={fill} />
            {children}
        </svg>
    );
}

const glyph = {
    stroke: "#fff",
    strokeWidth: 2.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
} as const;

function Bitcoin(props: IconProps) {
    return (
        <Coin fill="#f7931a" {...props}>
            <g transform="rotate(14 16 16)" {...glyph}>
                <path d="M11.5 9.5h5.25a3.25 3.25 0 0 1 0 6.5H11.5ZM11.5 16h6a3.25 3.25 0 0 1 0 6.5h-6Z" />
                <path d="M13.5 7v2.5M17 7v2.5M13.5 22.5V25M17 22.5V25" strokeWidth={2} />
            </g>
        </Coin>
    );
}

function Ether(props: IconProps) {
    return (
        <Coin fill="#627eea" {...props}>
            <path d="M16 5v8.1l6.9 3.1Z" fill="#fff" fillOpacity={0.6} />
            <path d="M16 5 9.1 16.2l6.9-3.1Z" fill="#fff" />
            <path d="M16 21.4V27l6.9-9.4Z" fill="#fff" fillOpacity={0.6} />
            <path d="M16 27v-5.6l-6.9-3.8Z" fill="#fff" />
            <path d="m16 20.1 6.9-3.9-6.9-3.1Z" fill="#fff" fillOpacity={0.2} />
            <path d="m9.1 16.2 6.9 3.9v-7Z" fill="#fff" fillOpacity={0.6} />
        </Coin>
    );
}

function Solana(props: IconProps) {
    const gradient = useId();
    return (
        <Coin fill="#14151a" {...props}>
            <defs>
                <linearGradient id={gradient} x1="8" y1="24" x2="24" y2="8" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#9945ff" />
                    <stop offset="1" stopColor="#14f195" />
                </linearGradient>
            </defs>
            <g fill={`url(#${gradient})`}>
                <path d="M11.2 9.5H24l-2.7 2.7H8.5Z" />
                <path d="M8.5 14.65h12.8l2.7 2.7H11.2Z" />
                <path d="M11.2 19.8H24l-2.7 2.7H8.5Z" />
            </g>
        </Coin>
    );
}

function Doge(props: IconProps) {
    return (
        <Coin fill="#c2a633" {...props}>
            <g {...glyph}>
                <path d="M12.5 9h3.75a7 7 0 0 1 0 14H12.5Z" />
                <path d="M10 16h7" />
            </g>
        </Coin>
    );
}

function Chainlink(props: IconProps) {
    return (
        <Coin fill="#2a5ada" {...props}>
            <path d="m16 8.5 6.5 3.75v7.5L16 23.5l-6.5-3.75v-7.5Z" {...glyph} />
        </Coin>
    );
}

function UsdCoin(props: IconProps) {
    return (
        <Coin fill="#2775ca" {...props}>
            <g {...glyph} strokeWidth={2.2}>
                <path d="M19.4 12.6c-.5-1.4-1.8-2.2-3.4-2.2-2 0-3.4 1-3.4 2.6 0 3.7 7 1.9 7 5.8 0 1.6-1.5 2.8-3.6 2.8-1.8 0-3.2-.9-3.6-2.4M16 8.6v1.8M16 21.6v1.8" />
                <path d="M10.2 8.6a9.5 9.5 0 0 0 0 14.8M21.8 8.6a9.5 9.5 0 0 1 0 14.8" strokeWidth={1.6} />
            </g>
        </Coin>
    );
}

function Bnb(props: IconProps) {
    return (
        <Coin fill="#f0b90b" {...props}>
            <g fill="#fff">
                <path d="m16 13.2 2.8 2.8-2.8 2.8-2.8-2.8z" />
                <path d="m16 7.5 4.4 4.4-1.6 1.6L16 10.7l-2.8 2.8-1.6-1.6zM16 24.5l-4.4-4.4 1.6-1.6 2.8 2.8 2.8-2.8 1.6 1.6z" />
                <path
                    d="m8.9 12.6 1.6 1.6L8.9 15.8 7.3 14.2zM23.1 12.6l1.6 1.6-1.6 1.6-1.6-1.6z"
                    transform="translate(0 1.8)"
                />
            </g>
        </Coin>
    );
}

function Tether(props: IconProps) {
    return (
        <Coin fill="#26a17b" {...props}>
            <g {...glyph} strokeWidth={2.4}>
                <path d="M9.5 10h13M16 10v13" />
                <path d="M11 16.2c1.2.7 3 1.1 5 1.1s3.8-.4 5-1.1" strokeWidth={1.8} />
            </g>
        </Coin>
    );
}

const ICONS: Partial<Record<CoinSymbol, (props: IconProps) => JSX.Element>> = {
    BTC: Bitcoin,
    ETH: Ether,
    SOL: Solana,
    DOGE: Doge,
    LINK: Chainlink,
    USDC: UsdCoin,
    BNB: Bnb,
    USDT: Tether,
};

/** The ticker's first two letters on a hue seeded by the ticker. */
function LetterCoin({ symbol, ...props }: IconProps & { symbol: CoinSymbol }) {
    const hue = [...symbol].reduce((h, char) => (h * 31 + char.charCodeAt(0)) % 360, 17);
    return (
        <Coin fill={`hsl(${hue} 50% 44%)`} {...props}>
            <text
                x={16}
                y={16}
                dy="0.36em"
                textAnchor="middle"
                fill="#fff"
                fontFamily="inherit"
                fontSize={12.5}
                fontWeight={700}
                letterSpacing={-0.4}
            >
                {symbol.slice(0, 2)}
            </text>
        </Coin>
    );
}

export function CoinIcon({ symbol, ...props }: IconProps & { symbol: CoinSymbol }) {
    const Icon = ICONS[symbol];
    return Icon ? <Icon {...props} /> : <LetterCoin symbol={symbol} {...props} />;
}
