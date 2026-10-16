/** Side of the working image the shape is measured on. */
export const WORK_SIZE = 256;

/** The measured circle, as a share of the image's half-width: just inside a round logo's edge. */
const DISC_RADIUS = 0.92;

/** A pixel at least this opaque counts as part of the logo. */
const OPAQUE = 230;

/**
 * A logo that fills at least this much of that circle is a round coin and is shown as drawn. On the live
 * Hyperliquid set, the hollow rings that need a disc (WLD, BIGTIME) reach 0.57 and the marks reach 0.74,
 * while round coins with cut-outs or padding and the circular photos (PNUT, MELANIA, MOODENG) start at 0.75.
 */
export const ROUND_COVERAGE = 0.75;

/** A mark lighter than this on average would vanish on the light disc, so it gets the dark one. */
export const LIGHT_MARK = 0.8;

/** A pixel with a channel above this (0 to 1) is lit: something to see on the dark app. */
const LIT = 0.4;

/**
 * A logo with less than this share of lit pixels is black on the dark app and shows nothing, so it gets the
 * light disc. On the live set only FARTCOIN (0.013) is below it; the next darkest coin, GOAT, has 0.031.
 */
export const MIN_LIT_SHARE = 0.02;

export type Measure = {
    /** The share of the circle just inside a round coin's edge that is opaque. */
    coverage: number;
    /** The logo's average brightness, 0 (black) to 1 (white), weighted by opacity. */
    luma: number;
    /** The share of its opaque pixels that are lit. */
    lit: number;
};

/** How much of the middle circle a logo fills, and how light it is, in an RGBA image `size` pixels square. */
export function measure(rgba: Uint8Array, size = WORK_SIZE): Measure {
    const centre = (size - 1) / 2;
    const limit = ((size / 2) * DISC_RADIUS) ** 2;
    let inside = 0;
    let opaque = 0;
    let light = 0;
    let weight = 0;
    let solid = 0;
    let lit = 0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const at = (y * size + x) * 4;
            const alpha = rgba[at + 3];
            if (alpha > 0) {
                const luma = (0.2126 * rgba[at] + 0.7152 * rgba[at + 1] + 0.0722 * rgba[at + 2]) / 255;
                light += luma * alpha;
                weight += alpha;
                if (alpha >= OPAQUE) {
                    solid++;
                    if (Math.max(rgba[at], rgba[at + 1], rgba[at + 2]) / 255 > LIT) lit++;
                }
            }
            if ((x - centre) ** 2 + (y - centre) ** 2 > limit) continue;
            inside++;
            if (alpha >= OPAQUE) opaque++;
        }
    }
    return { coverage: opaque / inside, luma: weight ? light / weight : 0, lit: solid ? lit / solid : 0 };
}

/** A round coin is shown as drawn; any other mark sits on a light disc, or on a dark one when it is itself light. */
export type Look = "round" | "light-disc" | "dark-disc";

export function chooseLook({ coverage, luma, lit }: Measure): Look {
    if (coverage >= ROUND_COVERAGE && lit >= MIN_LIT_SHARE) return "round";
    return luma >= LIGHT_MARK ? "dark-disc" : "light-disc";
}
