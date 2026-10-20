import type { Transition, Variants } from "motion/react";

/** Every layout move in the sentence uses this, so words and pills travel together. */
export const layoutSpring: Transition = { type: "spring", visualDuration: 0.4, bounce: 0.2 };
/** While typing an amount, the pill keeps up with the digits instead of springing. */
export const typingLayout: Transition = { type: "spring", visualDuration: 0.12, bounce: 0 };

export const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.45 };
export const wobble: Transition = { type: "spring", visualDuration: 0.4, bounce: 0.6 };
export const panelSpring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.35 };

export const pillVariants: Variants = {
    hover: { scale: 1.05 },
    tap: { scale: 0.92 },
};

export const iconVariants: Variants = {
    rest: { scale: 1, rotate: 0, x: "0em" },
    hover: { scale: 1.12, rotate: -10, x: "0em" },
    tap: { scale: 0.88, rotate: 4, x: "0em" },
    // A ringed pill's icon tucks into the circle of the pill's rounded end, clear of the ring: 1.29em across with
    // its sticker and centred 0.705em in, it otherwise hangs a little over the pill's 1.22em height, onto the ring.
    restTucked: { scale: 0.87, rotate: 0, x: "-0.095em" },
    hoverTucked: { scale: 0.92, rotate: -10, x: "-0.095em" },
    tapTucked: { scale: 0.77, rotate: 4, x: "-0.095em" },
};
