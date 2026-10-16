import sharp from "sharp";
import { WORK_SIZE, chooseLook, measure, type Look, type Measure } from "./shape";

/** Side of a served logo, in pixels: sharp up to 3x at CoinIcon's largest. */
export const LOGO_SIZE = 128;

/** The light disc CoinIcon always put a bare mark on, and the dark one of its placeholder for a mark too light for that. */
const DISC_COLOURS = { "light-disc": "#f5f5f3", "dark-disc": "#3a3a37" };
/** A mark fills this much of its disc: 62.5%, the old 62%. */
const MARK_SIZE = 80;

const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };
const MAX_PIXELS = 25_000_000;
const WEBP = { quality: 90, alphaQuality: 100 };

/** The logo drawn square on a clear background, large enough to measure and to shrink crisply. */
async function drawWork(source: Buffer, vector: boolean) {
    let input = sharp(source, { limitInputPixels: MAX_PIXELS });
    if (vector) {
        const { width = 0, height = 0 } = await input.metadata();
        if (!width || !height) throw new Error("the SVG has no size");
        // An SVG is drawn at a density, so give it the one that makes its longer side WORK_SIZE.
        const density = Math.min(20_000, Math.max(1, (72 * WORK_SIZE) / Math.max(width, height)));
        input = sharp(source, { density, limitInputPixels: MAX_PIXELS });
    }
    const { data, info } = await input
        .ensureAlpha()
        .resize(WORK_SIZE, WORK_SIZE, { fit: "contain", background: CLEAR })
        .raw()
        .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) throw new Error(`expected RGBA, got ${info.channels} channels`);
    return data;
}

export type RenderedLogo = Measure & { webp: Buffer; look: Look };

/**
 * A coin logo as a 128 px WebP, ready for CoinIcon to show edge to edge in a circle: a round coin as drawn,
 * any other mark at 62% on a disc. `vector` says the source is an SVG.
 */
export async function renderLogo(source: Buffer, vector: boolean): Promise<RenderedLogo> {
    const data = await drawWork(source, vector);
    const found = measure(data);
    const look = chooseLook(found);
    const work = sharp(data, { raw: { width: WORK_SIZE, height: WORK_SIZE, channels: 4 } });
    if (look === "round") {
        return { webp: await work.resize(LOGO_SIZE, LOGO_SIZE).webp(WEBP).toBuffer(), look, ...found };
    }

    const mark = await work.resize(MARK_SIZE, MARK_SIZE).png().toBuffer();
    const half = LOGO_SIZE / 2;
    const disc = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${LOGO_SIZE}" height="${LOGO_SIZE}">` +
            `<circle cx="${half}" cy="${half}" r="${half}" fill="${DISC_COLOURS[look]}"/></svg>`,
    );
    const webp = await sharp(disc)
        .composite([{ input: mark, left: (LOGO_SIZE - MARK_SIZE) / 2, top: (LOGO_SIZE - MARK_SIZE) / 2 }])
        .webp(WEBP)
        .toBuffer();
    return { webp, look, ...found };
}
