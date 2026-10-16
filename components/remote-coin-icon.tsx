"use client";

import { useState, type CSSProperties } from "react";
import Image from "next/image";

type RemoteCoinIconProps = {
    /** The ticker the placeholder shows: a k-asset's base coin. */
    ticker: string;
    /** The name the logo is asked for at /coin-logo, or null when the symbol can't be a coin's. */
    logo: string | null;
    className?: string;
    style?: CSSProperties;
};

/** The same grid cell, so the logo lies over the placeholder with no change in size. */
const STACKED: CSSProperties = { gridArea: "1 / 1", width: "100%", height: "100%" };

/**
 * A coin without a logo in the repo: a neutral disc with its ticker, and the logo from /coin-logo laid over
 * it once it arrives. A coin the route has no logo for keeps the disc. The route sends a finished disc or
 * round coin, so the placeholder is hidden behind a logo that has loaded.
 */
export function RemoteCoinIcon({ ticker, logo, className, style }: RemoteCoinIconProps) {
    const [loaded, setLoaded] = useState(false);
    const [failed, setFailed] = useState(false);
    return (
        <span
            aria-hidden="true"
            className={className}
            style={{
                display: "inline-grid",
                placeItems: "center",
                flexShrink: 0,
                borderRadius: "50%",
                overflow: "hidden",
                ...style,
                background: loaded ? "transparent" : "#3a3a37",
            }}
        >
            <svg viewBox="0 0 32 32" style={{ ...STACKED, visibility: loaded ? "hidden" : undefined }}>
                <text x={16} y={16} dy="0.36em" textAnchor="middle" fill="#c8c8c3" fontSize={11} fontWeight={600}>
                    {ticker.slice(0, 4)}
                </text>
            </svg>
            {logo && !failed && (
                <Image
                    src={`/coin-logo/${logo}`}
                    alt=""
                    width={64}
                    height={64}
                    unoptimized
                    loading="lazy"
                    draggable={false}
                    onLoad={() => setLoaded(true)}
                    onError={() => setFailed(true)}
                    style={STACKED}
                />
            )}
        </span>
    );
}
