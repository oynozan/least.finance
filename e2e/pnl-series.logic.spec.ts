import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { Server } from "socket.io";
import { AccountClient } from "@/components/account-client";
import type { ApiError } from "@/lib/account/state";
import { headingFor, hoverLine, localDate, nounFor, parseStart, valueText } from "@/lib/pnl/labels";
import { nextSeriesRequest, resetPnlStores, saveSeries, storedSeries, subscribeSeries } from "@/lib/pnl/series-store";
import type { PnlSeries } from "@/server/src/protocol";

const series = (tz: string, balance = "0"): PnlSeries => ({
    tz,
    ranges: {
        "7D": { unit: "day", points: [{ start: "2026-03-03", balance, pnl: "0", net: "0" }] },
        "30D": { unit: "day", points: [] },
        All: { unit: "day", points: [] },
    },
});

test("the heading follows the unit", () => {
    expect(headingFor("day", "2026-03-03")).toBe("Balance on Mar 3");
    expect(headingFor("week", "2026-03-02")).toBe("Balance, week of Mar 2");
    expect(headingFor("month", "2026-03-01")).toBe("Balance in March");
});

test("the noun follows the unit", () => {
    expect(nounFor("day")).toBe("that day");
    expect(nounFor("week")).toBe("that week");
    expect(nounFor("month")).toBe("that month");
});

test("the hover line says that day, that week or that month", () => {
    expect(hoverLine("week", 0)).toBe("PnL that week");
    expect(hoverLine("day", 0)).toBe("PnL that day");
    expect(hoverLine("day", 50)).toBe("PnL that day, and $50.00 deposited");
    expect(hoverLine("month", -20)).toBe("PnL that month, and $20.00 withdrawn");
    expect(hoverLine("week", 1234.5)).toBe("PnL that week, and $1,234.50 deposited");
});

test("a net that rounds to no cents says nothing about money moved", () => {
    expect(hoverLine("day", 0.004)).toBe("PnL that day");
    expect(hoverLine("day", -0.004)).toBe("PnL that day");
    expect(hoverLine("day", 0.01)).toBe("PnL that day, and $0.01 deposited");
});

test("valueText names the bucket", () => {
    expect(valueText("day", "2026-03-03", 500)).toBe("Mar 3: $500.00");
    expect(valueText("week", "2026-03-02", 500)).toBe("Week of Mar 2: $500.00");
    expect(valueText("month", "2026-03-01", 500)).toBe("March: $500.00");
});

test("parseStart gives local midnight on the date, also on daylight saving days", () => {
    const zone = process.env.TZ;
    try {
        for (const tz of [zone, "America/New_York", "Europe/Berlin", "Pacific/Auckland"]) {
            if (tz === undefined) delete process.env.TZ;
            else process.env.TZ = tz;
            for (const [start, month, day] of [
                ["2026-03-08", 3, 8],
                ["2026-11-01", 11, 1],
                ["2026-03-01", 3, 1],
            ] as const) {
                const date = parseStart(start);
                expect([tz, date.getFullYear(), date.getMonth() + 1, date.getDate()]).toEqual([tz, 2026, month, day]);
                expect([tz, date.getHours(), date.getMinutes()]).toEqual([tz, 0, 0]);
            }
        }
    } finally {
        if (zone === undefined) delete process.env.TZ;
        else process.env.TZ = zone;
    }
});

test("localDate is the calendar date in the browser's zone and turns over at local midnight", () => {
    expect(localDate(new Date(2026, 0, 5, 9, 30))).toBe("2026-01-05");
    expect(localDate(new Date(2026, 2, 8, 23, 59, 59, 999))).toBe("2026-03-08");
    expect(localDate(new Date(2026, 2, 9, 0, 0, 0, 0))).toBe("2026-03-09");
    expect(localDate(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
    expect(parseStart(localDate(new Date(2026, 9, 14, 17, 45)))).toEqual(new Date(2026, 9, 14));
});

test.describe("the series store", () => {
    test.beforeEach(() => resetPnlStores());

    test("the store keeps a series per zone", () => {
        expect(storedSeries("UTC")).toBeNull();
        const utc = series("UTC", "1");
        const berlin = series("Europe/Berlin", "2");
        expect(saveSeries("UTC", nextSeriesRequest(), utc)).toBe(true);
        expect(saveSeries("Europe/Berlin", nextSeriesRequest(), berlin)).toBe(true);
        expect(storedSeries("UTC")).toBe(utc);
        expect(storedSeries("Europe/Berlin")).toBe(berlin);
        expect(storedSeries("Asia/Tokyo")).toBeNull();
    });

    test("request numbers only go up", () => {
        const a = nextSeriesRequest();
        const b = nextSeriesRequest();
        expect(b).toBeGreaterThan(a);
    });

    test("a stale answer cannot replace a newer one", () => {
        const a = nextSeriesRequest();
        const b = nextSeriesRequest();
        const newer = series("UTC", "2");
        const older = series("UTC", "1");
        expect(saveSeries("UTC", b, newer)).toBe(true);
        expect(saveSeries("UTC", a, older)).toBe(false);
        expect(storedSeries("UTC")).toBe(newer);
    });

    test("a newer answer in one zone does not refuse an older one in another", () => {
        const a = nextSeriesRequest();
        const b = nextSeriesRequest();
        expect(saveSeries("Europe/Berlin", b, series("Europe/Berlin"))).toBe(true);
        expect(saveSeries("UTC", a, series("UTC"))).toBe(true);
    });

    test("an answer in order replaces the earlier one", () => {
        const a = nextSeriesRequest();
        const b = nextSeriesRequest();
        const first = series("UTC", "1");
        const second = series("UTC", "2");
        expect(saveSeries("UTC", a, first)).toBe(true);
        expect(saveSeries("UTC", b, second)).toBe(true);
        expect(storedSeries("UTC")).toBe(second);
    });

    test("resetPnlStores empties it", () => {
        saveSeries("UTC", nextSeriesRequest(), series("UTC"));
        saveSeries("Europe/Berlin", nextSeriesRequest(), series("Europe/Berlin"));
        resetPnlStores();
        expect(storedSeries("UTC")).toBeNull();
        expect(storedSeries("Europe/Berlin")).toBeNull();
    });

    test("an answer to a request sent before a reset is refused after it", () => {
        const old = nextSeriesRequest();
        resetPnlStores();
        expect(saveSeries("UTC", old, series("UTC", "9"))).toBe(false);
        expect(storedSeries("UTC")).toBeNull();
        const fresh = series("UTC", "1");
        expect(saveSeries("UTC", nextSeriesRequest(), fresh)).toBe(true);
        expect(storedSeries("UTC")).toBe(fresh);
    });

    test("a request older than a saved one stays refused after a reset empties the saved numbers", () => {
        const a = nextSeriesRequest();
        const b = nextSeriesRequest();
        saveSeries("UTC", b, series("UTC", "2"));
        resetPnlStores();
        expect(saveSeries("UTC", a, series("UTC", "1"))).toBe(false);
        expect(saveSeries("UTC", b, series("UTC", "2"))).toBe(false);
        expect(storedSeries("UTC")).toBeNull();
    });

    test("subscribers hear a save and not a refused save", () => {
        let heard = 0;
        const stop = subscribeSeries(() => heard++);
        const a = nextSeriesRequest();
        const b = nextSeriesRequest();
        saveSeries("UTC", b, series("UTC", "2"));
        expect(heard).toBe(1);
        saveSeries("UTC", a, series("UTC", "1"));
        expect(heard).toBe(1);
        resetPnlStores();
        expect(heard).toBe(2);
        stop();
        saveSeries("UTC", nextSeriesRequest(), series("UTC"));
        expect(heard).toBe(2);
    });
});

/** A socket.io server that opens the account and leaves `pnl:series` to the test. */
const OPENED = {
    ok: true,
    data: {
        account: { depositAddress: "0x00000000000000000000000000000000000000b2", balance: "300", version: 1 },
        deposits: { items: [], next: null },
        rules: { chainId: 5042, minDeposit: "0.01" },
        orders: [],
        withdrawals: [],
        solana: { deposits: false, withdrawals: false },
    },
};

async function fakeServer(
    onSeries: (payload: { tz: string }, ack: (result: unknown) => void) => void,
    onOpen: (ack: (result: unknown) => void) => void = (ack) => ack(OPENED),
) {
    const http = createServer();
    const io = new Server(http);
    const asked: { tz: string }[] = [];
    io.on("connection", (socket) => {
        socket.on("account:open", (_payload, ack) => onOpen(ack));
        socket.on("pnl:series", (payload, ack) => {
            asked.push(payload);
            onSeries(payload, ack);
        });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const client = new AccountClient(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
    return {
        client,
        io,
        asked,
        open: async () => {
            client.connect("user", async () => "token");
            await expect.poll(() => client.getSnapshot().pnl.bound).toBe(1);
        },
        stop: async () => {
            client.disconnect();
            await io.close();
        },
    };
}

test.describe("the account client's series plumbing", () => {
    test.beforeEach(() => resetPnlStores());

    test("a bind counts once, each pnl:changed counts, and the series is asked with the zone", async () => {
        const stack = await fakeServer((payload, ack) => ack({ ok: true, data: series(payload.tz, "7") }));
        try {
            expect(await stack.client.loadPnlSeries("UTC")).toMatchObject({ code: "unavailable" });
            expect(stack.client.getSnapshot().pnl).toEqual({ bound: 0, changed: 0 });
            await stack.open();
            expect(stack.client.getSnapshot().pnl).toEqual({ bound: 1, changed: 0 });
            expect(await stack.client.loadPnlSeries("Europe/Berlin")).toEqual(series("Europe/Berlin", "7"));
            expect(stack.asked).toEqual([{ tz: "Europe/Berlin" }]);
            let emitted = 0;
            stack.client.subscribe(() => emitted++);
            stack.io.emit("pnl:changed");
            stack.io.emit("pnl:changed");
            await expect.poll(() => stack.client.getSnapshot().pnl.changed).toBe(2);
            expect(emitted).toBe(2);
            expect(stack.client.getSnapshot().pnl.bound).toBe(1);
        } finally {
            await stack.stop();
        }
    });

    test("an error answer comes back as the error", async () => {
        const error: ApiError = { code: "internal", message: "Something went wrong." };
        const stack = await fakeServer((_payload, ack) => ack({ ok: false, error }));
        try {
            await stack.open();
            expect(await stack.client.loadPnlSeries("UTC")).toEqual(error);
        } finally {
            await stack.stop();
        }
    });

    test("a reconnect binds again and counts again", async () => {
        const stack = await fakeServer((payload, ack) => ack({ ok: true, data: series(payload.tz) }));
        try {
            await stack.open();
            for (const socket of stack.io.sockets.sockets.values()) socket.disconnect();
            await expect.poll(() => stack.client.getSnapshot().pnl.bound).toBe(2);
            expect(await stack.client.loadPnlSeries("UTC")).toEqual(series("UTC"));
        } finally {
            await stack.stop();
        }
    });

    test("signing out empties the counters and the stored series", async () => {
        const stack = await fakeServer((payload, ack) => ack({ ok: true, data: series(payload.tz) }));
        try {
            await stack.open();
            stack.io.emit("pnl:changed");
            await expect.poll(() => stack.client.getSnapshot().pnl.changed).toBe(1);
            const request = nextSeriesRequest();
            const answer = await stack.client.loadPnlSeries("UTC");
            expect(saveSeries("UTC", request, answer as PnlSeries)).toBe(true);
            stack.client.disconnect();
            expect(stack.client.getSnapshot().pnl).toEqual({ bound: 0, changed: 0 });
            expect(storedSeries("UTC")).toBeNull();
            expect(await stack.client.loadPnlSeries("UTC")).toMatchObject({ code: "unavailable" });
        } finally {
            await stack.stop();
        }
    });

    test("nothing is asked while a reconnected socket is not yet bound to the account", async () => {
        let opens = 0;
        let release: (result: unknown) => void = () => undefined;
        const stack = await fakeServer(
            (payload, ack) => ack({ ok: true, data: series(payload.tz) }),
            (ack) => (++opens === 1 ? ack(OPENED) : (release = ack)),
        );
        try {
            await stack.open();
            for (const socket of stack.io.sockets.sockets.values()) socket.disconnect();
            await expect.poll(() => opens).toBe(2);
            expect(await stack.client.loadPnlSeries("UTC")).toMatchObject({ code: "unavailable" });
            expect(stack.asked).toEqual([]);
            release(OPENED);
            await expect.poll(() => stack.client.getSnapshot().pnl.bound).toBe(2);
            expect(await stack.client.loadPnlSeries("UTC")).toEqual(series("UTC"));
            expect(stack.asked).toEqual([{ tz: "UTC" }]);
        } finally {
            await stack.stop();
        }
    });

    test("an ask pending when the person signs out comes back unreachable and stores nothing", async () => {
        const stack = await fakeServer(() => undefined);
        try {
            await stack.open();
            const pending = stack.client.loadPnlSeries("UTC");
            await expect.poll(() => stack.asked.length).toBe(1);
            stack.client.disconnect();
            expect(await pending).toMatchObject({ code: "unavailable" });
            expect(storedSeries("UTC")).toBeNull();
        } finally {
            await stack.stop();
        }
    });
});
