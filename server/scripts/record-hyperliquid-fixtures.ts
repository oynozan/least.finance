// Records the public metaAndAssetCtxs (trimmed to the catalog assets), a clearinghouseState and a userFills sample from Hyperliquid; it never signs.
// Run from server/: node scripts/record-hyperliquid-fixtures.ts [--user 0x...] with HYPERLIQUID_API_URL set for testnet (mainnet by default), then npx prettier --write server/test/fixtures from the root.
// clearinghouse.json and fills.json need --user, an address that has traded; without it only meta.json is recorded.
import { mkdirSync, writeFileSync } from "node:fs";

const API_URL = process.env.HYPERLIQUID_API_URL ?? "https://api.hyperliquid.xyz";
const CATALOG = ["BTC", "ETH", "SOL", "LINK", "DOGE"];
const userFlag = process.argv.indexOf("--user");
const user = userFlag === -1 ? undefined : process.argv[userFlag + 1];

type Universe = { name: string; marginTableId: number } & Record<string, unknown>;
type Meta = { universe: Universe[]; marginTables: [number, unknown][] } & Record<string, unknown>;

async function info(body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${API_URL}/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${body.type as string} answered ${response.status}: ${await response.text()}`);
    return response.json();
}

function save(file: string, body: unknown) {
    const directory = new globalThis.URL("../test/fixtures/hyperliquid/", import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new globalThis.URL(file, directory), `${JSON.stringify(body, null, 4)}\n`);
    console.log(`recorded hyperliquid/${file}`);
}

const [meta, contexts] = (await info({ type: "metaAndAssetCtxs" })) as [Meta, Record<string, unknown>[]];
const kept = meta.universe.flatMap((entry, index) =>
    CATALOG.includes(entry.name) ? [{ entry, ctx: contexts[index]! }] : [],
);
const tableIds = new Set(kept.map(({ entry }) => entry.marginTableId));
save("meta.json", [
    {
        ...meta,
        universe: kept.map(({ entry }) => entry),
        marginTables: meta.marginTables.filter(([id]) => tableIds.has(id)),
    },
    kept.map(({ ctx }) => ctx),
]);

if (!user) {
    console.log("pass --user 0x... to record clearinghouse.json and fills.json");
} else {
    save("clearinghouse.json", await info({ type: "clearinghouseState", user }));
    save("fills.json", (await info({ type: "userFills", user })) as unknown[]);
}
