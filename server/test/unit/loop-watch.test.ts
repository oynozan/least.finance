import { pino } from "pino";
import { expect, test } from "vitest";
import { loopWatch } from "../../src/loop-watch.ts";

const lines: Record<string, any>[] = [];
const logger = pino({ level: "info" }, { write: (chunk: string) => void lines.push(JSON.parse(chunk)) });

test("a failing loop logs its first failure and then one in ten, waits longer each time, and says when it recovers", () => {
    lines.length = 0;
    const watch = loopWatch(logger, "payout");
    const waits = Array.from({ length: 12 }, () => watch.failed(new Error("mongo down"), 1_000));
    expect(waits.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(Math.max(...waits)).toBe(30_000);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
        level: 40,
        event: "loop.failed",
        loop: "payout",
        consecutive: 1,
        err: { message: "mongo down" },
    });
    expect(lines[1]).toMatchObject({ consecutive: 10 });

    watch.ok();
    expect(lines.at(-1)).toMatchObject({ level: 40, event: "loop.recovered", loop: "payout", failures: 12 });
    watch.ok();
    expect(lines.at(-1)).toMatchObject({ event: "loop.recovered" });
    expect(lines).toHaveLength(3);
});
