import { expect, it } from "vitest";
import { outageLog } from "../../src/log-throttle.ts";

const make = () => {
    const lines: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
    const clock = { t: 0 };
    const logger = {
        warn: (fields: object, message: string) => void lines.push({ level: "warn", fields: fields as never, message }),
        error: (fields: object, message: string) =>
            void lines.push({ level: "error", fields: fields as never, message }),
    };
    return { lines, clock, log: outageLog(logger, () => clock.t) };
};

it("logs the first failure, holds the rest for an hour, and says once when it clears", () => {
    const { lines, clock, log } = make();
    for (let i = 0; i < 100; i++) {
        clock.t += 1000;
        log.failed("rpc", "warn", { n: i }, "RPC down");
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn", message: "RPC down", fields: { n: 0 } });

    clock.t += 3_600_000;
    log.failed("rpc", "warn", {}, "RPC down");
    expect(lines).toHaveLength(2);
    expect(lines[1]!.fields).toMatchObject({ stillFailing: true, heldBack: 99 });

    log.ok("rpc", "RPC works again");
    log.ok("rpc", "RPC works again");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({ message: "RPC works again" });
});

it("keeps keys apart and logs a failure again after it has cleared", () => {
    const { lines, log } = make();
    log.failed("a", "error", {}, "A");
    log.failed("b", "warn", {}, "B");
    log.failed("a", "error", {}, "A");
    expect(lines.map((l) => l.message)).toEqual(["A", "B"]);
    log.ok("a", "A back");
    log.failed("a", "error", {}, "A");
    expect(lines.map((l) => l.message)).toEqual(["A", "B", "A back", "A"]);
    expect(log.isDown("a")).toBe(true);
});

it("says nothing for a key that never failed", () => {
    const { lines, log } = make();
    log.ok("x", "back");
    expect(lines).toEqual([]);
});
