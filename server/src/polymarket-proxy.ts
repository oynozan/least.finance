import { readFileSync } from "node:fs";
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from "undici";

let proxy = "";
try {
    proxy = readFileSync(new URL("../../proxy/proxy.txt", import.meta.url), "utf8").trim();
} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

if (proxy) {
    let agent: ProxyAgent;
    try {
        const url = new URL(proxy);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
        agent = new ProxyAgent(proxy);
    } catch {
        throw new Error("proxy/proxy.txt must contain one HTTP or HTTPS proxy URL");
    }

    // Also covers the SDK's internal fetch calls without changing other API traffic.
    setGlobalDispatcher(
        getGlobalDispatcher().compose((dispatch) => (options, handler) => {
            const hostname = new URL(String(options.origin)).hostname;
            return hostname === "polymarket.com" || hostname.endsWith(".polymarket.com")
                ? agent.dispatch(options, handler)
                : dispatch(options, handler);
        }),
    );
}
