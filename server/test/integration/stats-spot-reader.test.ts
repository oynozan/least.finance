import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createSpotReader } from "../../src/stats/hyperliquid.ts";

let server: Server;
let url = "";
const bodies: unknown[] = [];

beforeAll(async () => {
    server = createServer((req, res) => {
        let text = "";
        req.on("data", (chunk) => (text += chunk));
        req.on("end", () => {
            bodies.push({ path: req.url, body: JSON.parse(text) });
            res.setHeader("content-type", "application/json");
            res.end(
                JSON.stringify({
                    balances: [{ coin: "USDC", token: 0, total: "12.345678", hold: "0", entryNtl: "0" }],
                }),
            );
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("the spot reader asks the URL it was given", async () => {
    const e6 = await createSpotReader(url)("0x00000000000000000000000000000000000000c1");
    expect(e6).toBe(12_345_678n);
    expect(bodies).toEqual([
        { path: "/info", body: { type: "spotClearinghouseState", user: "0x00000000000000000000000000000000000000c1" } },
    ]);
});
