"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { IconRef } from "@/lib/sentence";

type RenderIcon = (icon: IconRef) => ReactNode;

const IconContext = createContext<RenderIcon>(() => null);

/**
 * The engine only names icons ({ set: "coin", id: "ETH" }); the domain
 * supplies how each set is drawn.
 */
export function SentenceIcons({ render, children }: { render: RenderIcon; children: ReactNode }) {
    return <IconContext value={render}>{children}</IconContext>;
}

export function SentenceIcon({ icon }: { icon?: IconRef }) {
    const render = useContext(IconContext);
    return icon ? render(icon) : null;
}
