// Read-only diagnostics; run on the same machine and as the same user as PM2.
import { fileURLToPath } from "node:url";
import { createPublicClient } from "@polymarket/client";
import { fetch, getGlobalDispatcher } from "undici";

const direct = getGlobalDispatcher();
await import("../src/polymarket-proxy.ts");
const configured = getGlobalDispatcher();
const proxyEnabled = configured !== direct;
console.log({
    node: process.version,
    proxyFile: fileURLToPath(new URL("../../proxy/proxy.txt", import.meta.url)),
    proxyEnabled,
});
if (!proxyEnabled) console.error("Proxy file is missing or blank; Polymarket requests connect directly.");

let failed = !proxyEnabled;
await Promise.all(
    [
        { check: "direct-geoblock", url: "https://polymarket.com/api/geoblock", dispatcher: direct },
        { check: "configured-geoblock", url: "https://polymarket.com/api/geoblock", dispatcher: configured },
        { check: "configured-gamma", url: "https://gamma-api.polymarket.com/events?limit=1", dispatcher: configured },
        { check: "configured-clob", url: "https://clob.polymarket.com/time", dispatcher: configured },
    ].map(async ({ check, url, dispatcher }) => {
        try {
            const options = { dispatcher, signal: AbortSignal.timeout(15_000) };
            const response = await fetch(url, options);
            const body: unknown = await response.json().catch(() => null);
            const geo = check.endsWith("geoblock")
                ? (body as { blocked?: boolean; country?: string; region?: string } | null)
                : undefined;
            console.log({
                check,
                status: response.status,
                ...(geo && { blocked: geo.blocked, country: geo.country, region: geo.region }),
            });
            if (check !== "direct-geoblock" && !response.ok) failed = true;
            if (check === "configured-geoblock" && geo?.blocked !== false) failed = true;
        } catch (error) {
            const err = error as Error & { cause?: { code?: string } };
            console.error({ check, error: err.name, code: err.cause?.code });
            if (check !== "direct-geoblock") failed = true;
        }
    }),
);

// Exercise the SDK's own HTTP transport, which is also used for order submission.
try {
    const page = await createPublicClient().listEvents({ pageSize: 1 }).firstPage();
    console.log({ check: "sdk-events", ok: true, events: page.items.length });
} catch (error) {
    console.error({ check: "sdk-events", error: (error as Error).name });
    failed = true;
}
console.log("Read-only checks only; no order was submitted. Restart PM2 after changing proxy.txt.");
process.exit(failed ? 1 : 0);
