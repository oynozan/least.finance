import { describe, expect, it } from "vitest";
import { zoneOf } from "../../src/pnl/zones.ts";

const at = (iso: string) => Date.parse(iso);

describe("zoneOf", () => {
    it("an event at 23:30 UTC is the next day in Asia/Tokyo and the same day in UTC", () => {
        const ms = at("2026-10-13T23:30:00Z");
        expect(zoneOf("Asia/Tokyo").dateOf(ms)).toBe("2026-10-14");
        expect(zoneOf("UTC").dateOf(ms)).toBe("2026-10-13");
    });

    it("New York spring-forward day keeps 00:30 and 23:30 local on one date", () => {
        const ny = zoneOf("America/New_York");
        expect(ny.dateOf(at("2026-03-08T05:30:00Z"))).toBe("2026-03-08");
        expect(ny.dateOf(at("2026-03-09T03:30:00Z"))).toBe("2026-03-08");
        expect(ny.dateOf(at("2026-03-08T04:59:00Z"))).toBe("2026-03-07");
    });

    it("New York fall-back day keeps 00:30 and 23:30 local on one date", () => {
        const ny = zoneOf("America/New_York");
        expect(ny.dateOf(at("2026-11-01T04:30:00Z"))).toBe("2026-11-01");
        expect(ny.dateOf(at("2026-11-02T04:30:00Z"))).toBe("2026-11-01");
        expect(ny.dateOf(at("2026-11-02T05:00:00Z"))).toBe("2026-11-02");
    });

    it("Asia/Kolkata and Asia/Kathmandu cut on local midnight", () => {
        const kolkata = zoneOf("Asia/Kolkata");
        expect(kolkata.dateOf(at("2026-10-13T18:29:00Z"))).toBe("2026-10-13");
        expect(kolkata.dateOf(at("2026-10-13T18:30:00Z"))).toBe("2026-10-14");
        const kathmandu = zoneOf("Asia/Kathmandu");
        expect(kathmandu.dateOf(at("2026-10-13T18:14:00Z"))).toBe("2026-10-13");
        expect(kathmandu.dateOf(at("2026-10-13T18:15:00Z"))).toBe("2026-10-14");
    });

    it("current names work", () => {
        const kyiv = zoneOf("Europe/Kyiv");
        expect(kyiv.tz).toBe("Europe/Kyiv");
        expect(kyiv.dateOf(at("2026-10-13T21:30:00Z"))).toBe("2026-10-14");
        const buenosAires = zoneOf("America/Argentina/Buenos_Aires");
        expect(buenosAires.tz).toBe("America/Argentina/Buenos_Aires");
        expect(buenosAires.dateOf(at("2026-10-14T02:30:00Z"))).toBe("2026-10-13");
    });

    it.each(["Not/AZone", "", "x".repeat(64)])("a name Intl rejects is UTC (%j)", (name) => {
        const zone = zoneOf(name);
        expect(zone.tz).toBe("UTC");
        expect(zone.dateOf(at("2026-10-13T23:30:00Z"))).toBe("2026-10-13");
        expect(zone.dateOf(at("2026-10-14T00:00:00Z"))).toBe("2026-10-14");
    });

    it("a zone is built once", () => {
        expect(zoneOf("Asia/Tokyo")).toBe(zoneOf("Asia/Tokyo"));
        expect(zoneOf("Not/AZone")).toBe(zoneOf("Not/AZone"));
    });

    it("the cache stays bounded, and a zone built again still cuts the same days", () => {
        const name = "America/Argentina/Buenos_Aires";
        const first = zoneOf(name);
        for (let mask = 1; mask <= 600; mask++) {
            let bit = 0;
            zoneOf(
                name.replace(/[a-z]/gi, (char) =>
                    ((mask >> bit++) & 1) === 1 ? char.toUpperCase() : char.toLowerCase(),
                ),
            );
        }
        const again = zoneOf(name);
        expect(again).not.toBe(first);
        expect(again.tz).toBe(name);
        expect(again.dateOf(at("2026-10-14T02:30:00Z"))).toBe(first.dateOf(at("2026-10-14T02:30:00Z")));
    });
});
