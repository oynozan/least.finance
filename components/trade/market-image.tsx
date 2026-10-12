"use client";

import { useState } from "react";
import Image from "next/image";

const HOST = "polymarket-upload.s3.us-east-2.amazonaws.com";

const allowed = (src: string) => {
    try {
        return new URL(src).hostname === HOST;
    } catch {
        return false;
    }
};

/** A market's own picture, round like the coin icons; nothing is drawn in its place if it won't load. */
export function MarketImage({ src }: { src: string }) {
    const [failed, setFailed] = useState<string | null>(null);
    if (failed === src || !allowed(src)) return null;
    return (
        <Image
            src={src}
            alt=""
            width={48}
            height={48}
            onError={() => setFailed(src)}
            className="size-[1.15em] rounded-full object-cover shadow-[0_0_0_0.07em_#fff]"
        />
    );
}
