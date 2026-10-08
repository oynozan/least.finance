import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

// Sticker-style icons: each shape is drawn twice, a thick white stroke
// underneath and the colored fill on top, so the outline only grows outward.

export function ChatBubblesIcon(props: IconProps) {
  const yellow =
    "M14 6h26a8 8 0 0 1 8 8v13a8 8 0 0 1-8 8H20l-7.5 11.5.3-11.9A8 8 0 0 1 6 27V14a8 8 0 0 1 8-8Z";
  const blue =
    "M32 27h20a8 8 0 0 1 8 8v13a8 8 0 0 1-8 8H49.5l-.6 8.5L40 56H32a8 8 0 0 1-8-8V35a8 8 0 0 1 8-8Z";

  return (
    <svg viewBox="0 0 66 70" fill="none" aria-hidden="true" {...props}>
      <g stroke="#fff" strokeWidth={8} strokeLinejoin="round">
        <path d={yellow} transform="rotate(5 27 24)" />
        <path d={blue} transform="rotate(6 42 45)" />
      </g>
      <g transform="rotate(5 27 24)">
        <path d={yellow} fill="#f7d15b" />
        <path
          d="M16 18.5h21M16 26.5h12"
          stroke="#a2792a"
          strokeWidth={3.4}
          strokeLinecap="round"
        />
      </g>
      <g transform="rotate(6 42 45)">
        <path d={blue} fill="#468df7" />
        <circle cx={34.5} cy={41} r={4} fill="#fff" />
        <path d="M46 36.5 51.5 45h-11Z" fill="#bfe4fc" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

export function TypeIcon(props: IconProps) {
  const text = {
    x: 31,
    y: 33,
    textAnchor: "middle" as const,
    fontFamily: "inherit",
    fontSize: 42,
    fontWeight: 600,
    letterSpacing: -4,
  };

  return (
    <svg viewBox="0 0 62 42" fill="none" aria-hidden="true" {...props}>
      <text
        {...text}
        stroke="#fff"
        strokeWidth={7}
        strokeLinejoin="round"
        fill="#fff"
      >
        Aa
      </text>
      <text {...text} fill="#68d670">
        Aa
      </text>
    </svg>
  );
}

export function CursorIcon(props: IconProps) {
  const hexagon = "M39.1 9.4 79.7 20.3 90.6 60.9 60.9 90.6 20.3 79.7 9.4 39.1Z";

  return (
    <svg viewBox="0 0 100 100" fill="none" aria-hidden="true" {...props}>
      <path d={hexagon} stroke="#fff" strokeWidth={16} strokeLinejoin="round" />
      <path
        d={hexagon}
        fill="#000"
        stroke="#000"
        strokeWidth={4}
        strokeLinejoin="round"
      />
      <path
        d="M12.3 39.8 77.5 22.5 60.2 87.7 46.5 50.5Z"
        fill="#fff"
        stroke="#fff"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SystemsIcon(props: IconProps) {
  const tiles = [
    { x: 8, y: 8, fill: "#ff6b5b" },
    { x: 34, y: 8, fill: "#f7d15b" },
    { x: 8, y: 34, fill: "#468df7" },
    { x: 34, y: 34, fill: "#68d670" },
  ];

  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
      <g transform="rotate(-6 32 32)">
        {tiles.map(({ x, y }) => (
          <rect
            key={`${x}-${y}`}
            x={x}
            y={y}
            width={22}
            height={22}
            rx={6}
            stroke="#fff"
            strokeWidth={8}
          />
        ))}
        {tiles.map(({ x, y, fill }) => (
          <rect key={fill} x={x} y={y} width={22} height={22} rx={6} fill={fill} />
        ))}
      </g>
    </svg>
  );
}

export function IdentitiesIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
      <g transform="rotate(8 32 32)">
        <circle cx={32} cy={32} r={24} stroke="#fff" strokeWidth={8} />
        <circle cx={32} cy={32} r={24} fill="#f7d15b" />
        <ellipse cx={24} cy={27} rx={3.2} ry={4.6} fill="#3b2a12" />
        <ellipse cx={40} cy={27} rx={3.2} ry={4.6} fill="#3b2a12" />
        <path
          d="M21 37q11 10 22 0"
          stroke="#3b2a12"
          strokeWidth={4}
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

export function ColorIcon(props: IconProps) {
  const dots = [
    { cx: 23, cy: 25, fill: "#ff6b5b" },
    { cx: 41, cy: 25, fill: "#468df7" },
    { cx: 32, cy: 41, fill: "#f7d15b" },
  ];

  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
      {dots.map(({ cx, cy }) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={15} stroke="#fff" strokeWidth={8} />
      ))}
      {dots.map(({ cx, cy, fill }) => (
        <circle key={fill} cx={cx} cy={cy} r={15} fill={fill} />
      ))}
    </svg>
  );
}

export function StarIcon(props: IconProps) {
  const star =
    "M32 7 39.05 23.29 56.73 24.97 43.41 36.71 47.28 54.03 32 45 16.72 54.03 20.59 36.71 7.27 24.97 24.95 23.29Z";

  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
      <g transform="rotate(-8 32 32)">
        <path d={star} stroke="#fff" strokeWidth={12} strokeLinejoin="round" />
        <path
          d={star}
          fill="#ffb02e"
          stroke="#ffb02e"
          strokeWidth={4}
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

export function CodeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
      <g transform="rotate(6 32 32)">
        <rect x={8} y={8} width={48} height={48} rx={13} stroke="#fff" strokeWidth={8} />
        <rect x={8} y={8} width={48} height={48} rx={13} fill="#7c5cff" />
        <path
          d="M24 23.5 15.5 32l8.5 8.5M40 23.5l8.5 8.5-8.5 8.5M35.5 20l-7 24"
          stroke="#fff"
          strokeWidth={4.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

export function AgentsIcon(props: IconProps) {
  const head = "M22 17h20a12 12 0 0 1 12 12v12a12 12 0 0 1-12 12H22a12 12 0 0 1-12-12V29a12 12 0 0 1 12-12Z";

  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
      <g transform="rotate(-6 32 34)">
        <g stroke="#fff" strokeWidth={8} strokeLinejoin="round">
          <path d={head} />
          <path d="M32 17V8" strokeLinecap="round" />
          <circle cx={32} cy={7} r={4} />
        </g>
        <path d="M32 17V9" stroke="#2b8f86" strokeWidth={3.5} strokeLinecap="round" />
        <circle cx={32} cy={7} r={4.5} fill="#ff6b5b" />
        <path d={head} fill="#4fd1c5" />
        <circle cx={24} cy={34} r={4.5} fill="#10302d" />
        <circle cx={40} cy={34} r={4.5} fill="#10302d" />
        <path d="M27 44h10" stroke="#10302d" strokeWidth={3.5} strokeLinecap="round" />
      </g>
    </svg>
  );
}

export function SparkleIcon(props: IconProps) {
  const big = "M30 6c2 15 9 22 24 24-15 2-22 9-24 24-2-15-9-22-24-24 15-2 22-9 24-24Z";
  const small = "M51 5c.8 4.5 2.7 6.4 7 7-4.3.6-6.2 2.5-7 7-.8-4.5-2.7-6.4-7-7 4.3-.6 6.2-2.5 7-7Z";

  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
      <g stroke="#fff" strokeWidth={8} strokeLinejoin="round">
        <path d={big} />
        <path d={small} />
      </g>
      <path d={big} fill="#c58bff" />
      <path d={small} fill="#ffb02e" />
    </svg>
  );
}

export function PencilIcon(props: IconProps) {
  const outline = "M10 25h34l14 7-14 7H10a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4Z";

  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
      <g transform="rotate(-40 32 32)">
        <path d={outline} stroke="#fff" strokeWidth={8} strokeLinejoin="round" />
        <path d="M10 25h7v14h-7a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4Z" fill="#ff8fab" />
        <path d="M17 25h5v14h-5Z" fill="#c7c7c0" />
        <path d="M22 25h22v14H22Z" fill="#f7d15b" />
        <path d="M22 32h22" stroke="#d9a93a" strokeWidth={2} />
        <path d="M44 25l14 7-14 7Z" fill="#f3c999" />
        <path d="M52.5 29.2 58 32l-5.5 2.8Z" fill="#3b2a12" />
      </g>
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
      <circle cx={32} cy={32} r={24} stroke="#fff" strokeWidth={8} />
      <circle cx={32} cy={32} r={24} fill="#68d670" />
      <path
        d="M21 33l7.5 7.5L44 25"
        stroke="#fff"
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
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
