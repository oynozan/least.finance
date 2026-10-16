import { coinListing } from "@/lib/coin-logo/listed";
import { coinLogoBase } from "@/lib/coin-logo/symbol";
import { coinLogo, remoteLogosOn } from "@/lib/coin-logo/source";

// Runs on the Node.js runtime, the default: sharp draws the logos. Cache Components allows no `runtime` export.

const FOUND = "public, max-age=86400, stale-while-revalidate=604800";
const MISSING = "public, max-age=3600";
const FAILED = "public, max-age=60";

const notFound = (cacheControl: string) =>
    new Response(null, { status: 404, headers: { "Cache-Control": cacheControl } });

/** A listed coin's logo as a 128 px WebP, fetched from Hyperliquid and drawn on first request. 404 when there is none. */
export async function GET(_request: Request, ctx: { params: Promise<{ symbol: string }> }) {
    const { symbol } = await ctx.params;
    const base = coinLogoBase(symbol);
    if (!base) return notFound(MISSING);
    if (!remoteLogosOn()) return notFound("no-store");
    // Only a coin Hyperliquid lists is asked for, so a made-up ticker costs nothing upstream.
    const listing = await coinListing(symbol);
    if (listing !== "listed") return notFound(listing === "unlisted" ? MISSING : FAILED);
    const logo = await coinLogo(base);
    if (logo.status === "found") {
        return new Response(new Uint8Array(logo.webp), {
            headers: { "Content-Type": "image/webp", "Cache-Control": FOUND, "X-Content-Type-Options": "nosniff" },
        });
    }
    return notFound(logo.status === "missing" ? MISSING : FAILED);
}
