import { afterEach, expect, inject, test, vi } from "vitest";
import { PerpService } from "../../src/perps/perps.ts";
import { startStack, type Stack } from "../support/stack.ts";

let stack: Stack | undefined;
afterEach(async () => {
    vi.restoreAllMocks();
    await stack?.stop();
    stack = undefined;
});

test("the server listens before perps recovery finishes", { timeout: 15_000 }, async () => {
    vi.spyOn(PerpService.prototype, "recover").mockReturnValue(new Promise(() => undefined));

    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });

    expect((await fetch(stack.url)).status).toBeLessThan(500);
});
