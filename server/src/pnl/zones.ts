export type Zone = {
    tz: string;
    /** The local calendar date of an instant in epoch milliseconds, as YYYY-MM-DD */
    dateOf(ms: number): string;
};

// Names are caller input and case variants are all accepted, so the cache cannot grow without a bound
const MAX_ZONES = 256;

const zones = new Map<string, Zone>();
// Names Intl rejected, so each is reported once however often it is asked for
const rejected = new Set<string>();

function build(tz: string): Zone | null {
    let format: Intl.DateTimeFormat;
    try {
        format = new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            calendar: "gregory",
            numberingSystem: "latn",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        });
    } catch {
        return null;
    }
    return {
        tz,
        dateOf(ms) {
            const parts = format.formatToParts(ms);
            const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
            return `${part("year")}-${part("month")}-${part("day")}`;
        },
    };
}

/** The zone for an IANA name, built once, and UTC for a name Intl rejects; `onUnknown` hears each rejected name once */
export function zoneOf(tz: string, onUnknown?: (tz: string) => void): Zone {
    const known = zones.get(tz);
    if (known) return known;
    const zone = build(tz);
    if (!zone) {
        if (!rejected.has(tz)) {
            if (rejected.size >= MAX_ZONES) rejected.clear();
            rejected.add(tz);
            onUnknown?.(tz);
        }
        return zoneOf("UTC");
    }
    if (zones.size >= MAX_ZONES) {
        const oldest = zones.keys().next();
        if (!oldest.done) zones.delete(oldest.value);
    }
    zones.set(tz, zone);
    return zone;
}
