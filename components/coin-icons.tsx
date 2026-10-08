import { useId, type JSX, type SVGProps } from "react";

export type CoinSymbol = "BTC" | "ETH" | "SOL" | "DOGE" | "LINK" | "USDC";

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

const ICONS: Record<CoinSymbol, (props: IconProps) => JSX.Element> = {
  BTC: Bitcoin,
  ETH: Ether,
  SOL: Solana,
  DOGE: Doge,
  LINK: Chainlink,
  USDC: UsdCoin,
};

export function CoinIcon({ symbol, ...props }: IconProps & { symbol: CoinSymbol }) {
  const Icon = ICONS[symbol];
  return <Icon {...props} />;
}
