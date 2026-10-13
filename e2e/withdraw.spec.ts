import { expect, test } from "@playwright/test";
import { failNextPayout, fundTreasury, treasury } from "./backend";

test("the test backend funds the treasury and can fail a payout", async () => {
    await fundTreasury("123");
    expect((await treasury()).balance).toBe("123");
    await failNextPayout();
});
