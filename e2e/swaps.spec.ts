import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { fundSource, noSwapRoute, randomAddress, nextSwapQuote, setSwapStatus } from "./backend";
import {
    addressOf,
    installWallet,
    mockArcRpc,
    mockPrivy,
    rejectNextSend,
    rejectSendsAfter,
    sentHashes,
    walletRequests,
} from "./privy-mock";
import { connect, ethToUsdc, openReview, pickCoin, picker, reviewPanel, setAmount, trade } from "./swap-flow";

const confirmButton = (page: Page) => reviewPanel(page).getByRole("button", { name: "Confirm swap" });
const sends = async (page: Page) => (await walletRequests(page)).filter((r) => r.method === "eth_sendTransaction");

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
});

test("a swap shows LI.FI's quote and refreshes it", async ({ page }) => {
    // Counts the quotes the page asks for.
    let asked = 0;
    await page.routeWebSocket(/socket\.io/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => {
            if (typeof message === "string" && message.includes('"swap:quote"')) asked += 1;
            server.send(message);
        });
        server.onMessage((message) => ws.send(message));
    });
    await ethToUsdc(page);
    await openReview(page);
    const panel = reviewPanel(page);
    await expect(panel.getByText("Fake Bridge")).toBeVisible();
    await expect(panel.getByText(/^0\.003\d* ETH \(\$10\.00\) on Ethereum$/)).toBeVisible();
    await expect(panel.getByText(/^≈ 9\.97\d* USDC on Ethereum$/)).toBeVisible();
    await expect(panel.getByText(/^9\.9\d* USDC \(\$9\.9\d\)$/)).toBeVisible();
    await expect(panel.getByText(/^LI\.FI 0\.25% \(\$0\.0[23]\)$/)).toBeVisible();
    await expect(panel.getByText("≈ $0.05")).toBeVisible();
    await expect(panel.getByText("about 30 s")).toBeVisible();
    await expect(confirmButton(page)).not.toHaveAttribute("aria-disabled");
    // It is asked again every 15 seconds while the review is open.
    await expect.poll(() => asked, { timeout: 25_000 }).toBeGreaterThanOrEqual(2);
});

test("confirming sends from the wallet, then shows what arrived", async ({ page }) => {
    await ethToUsdc(page);
    await openReview(page);
    await expect(reviewPanel(page).getByText("Fake Bridge")).toBeVisible();
    await confirmButton(page).click();
    await expect(reviewPanel(page).getByText("Swap sent.")).toBeVisible({ timeout: 15_000 });
    expect(await sends(page)).toHaveLength(1);
    const [hash] = await sentHashes(page);
    await setSwapStatus(hash, "DONE", { substatus: "COMPLETED" });
    await expect(reviewPanel(page).getByText(/^Received 9\.97\d* USDC\.$/)).toBeVisible({ timeout: 30_000 });
    await reviewPanel(page).getByRole("button", { name: "Done" }).click();
});

test("a token swap approves first", async ({ page }) => {
    await fundSource(addressOf(page), "ethereum:USDC", "100");
    await page.goto("/");
    await connect(page);
    await pickCoin(page, "swap:fromToken", "USDC", "Ethereum");
    await pickCoin(page, "term:token", "ETH", "Ethereum");
    await openReview(page);
    await expect(reviewPanel(page).getByText("Approve USDC in your wallet, then confirm the swap.")).toBeVisible();
    await confirmButton(page).click();
    await expect(reviewPanel(page).getByText("Swap sent.")).toBeVisible({ timeout: 20_000 });
    const requests = await sends(page);
    expect(requests).toHaveLength(2);
    // The approval goes to the coin, then the swap to LI.FI's contract.
    const [approve, swap] = requests.map((r) => r.params![0] as { to: string; data: string });
    expect(approve.to.toLowerCase()).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(approve.data.startsWith("0x095ea7b3")).toBe(true);
    expect(swap.to.toLowerCase()).not.toBe(approve.to.toLowerCase());
});

test("rejecting in the wallet changes nothing", async ({ page }) => {
    await ethToUsdc(page);
    await openReview(page);
    await expect(reviewPanel(page).getByText("Fake Bridge")).toBeVisible();
    await rejectNextSend(page);
    await confirmButton(page).click();
    // Nothing is said, and the button is ready again.
    await expect(confirmButton(page)).toBeVisible();
    await expect(confirmButton(page)).toBeEnabled();
    await expect(reviewPanel(page).getByText("Swap sent.")).toHaveCount(0);
    expect(await sentHashes(page)).toHaveLength(0);
    await expect(reviewPanel(page).getByRole("alert")).toHaveCount(0);
    // The wallet still shows its whole ETH.
    await reviewPanel(page).getByRole("button", { name: "Close review" }).click();
    await trade(page).locator('[data-part="swap:fromToken"]').getByRole("button").click();
    await picker(page).getByRole("option", { name: "ETH", exact: true }).click();
    await expect(picker(page).getByRole("option").filter({ hasText: "Ethereum" }).first()).toContainText("1 ETH");
});

test("an approval that lands, then a rejected swap, spends no balance", async ({ page }) => {
    await fundSource(addressOf(page), "ethereum:USDC", "100");
    await page.goto("/");
    await connect(page);
    await pickCoin(page, "swap:fromToken", "USDC", "Ethereum");
    await pickCoin(page, "term:token", "ETH", "Ethereum");
    await openReview(page);
    await expect(reviewPanel(page).getByText("Approve USDC in your wallet, then confirm the swap.")).toBeVisible();
    await rejectSendsAfter(page, 1);
    await confirmButton(page).click();
    await expect.poll(async () => (await sentHashes(page)).length).toBe(1);
    await expect(confirmButton(page)).toBeEnabled();
    await expect(reviewPanel(page).getByText("Swap sent.")).toHaveCount(0);
    await reviewPanel(page).getByRole("button", { name: "Close review" }).click();
    await trade(page).locator('[data-part="swap:fromToken"]').getByRole("button").click();
    await picker(page).getByRole("option", { name: "USDC", exact: true }).click();
    await expect(picker(page).getByRole("option").filter({ hasText: "Ethereum" }).first()).toContainText("100 USDC");
});

test("no route says so", async ({ page }) => {
    await ethToUsdc(page);
    await noSwapRoute(addressOf(page));
    await openReview(page);
    await expect(reviewPanel(page).getByText("There's no route for this swap right now.")).toBeVisible();
    await expect(reviewPanel(page).getByRole("button", { name: "Confirm swap" })).toHaveAttribute(
        "aria-disabled",
        "true",
    );
});

test("the price moved says so and shows the new quote", async ({ page }) => {
    await ethToUsdc(page);
    await openReview(page);
    await expect(reviewPanel(page).getByText(/^9\.9\d* USDC \(\$9\.9\d\)$/)).toBeVisible();
    // The next quote LI.FI gives, the one the confirm asks for, is worth 5 USDC at least.
    await nextSwapQuote({ estimate: { toAmountMin: "5000000" } }, addressOf(page));
    await confirmButton(page).click();
    await expect(reviewPanel(page).getByText("The price moved. Check the new amount and confirm again.")).toBeVisible({
        timeout: 15_000,
    });
    await expect(reviewPanel(page).getByText("5 USDC ($5.00)")).toBeVisible({ timeout: 15_000 });
    expect(await sentHashes(page)).toHaveLength(0);
    await expect(confirmButton(page)).toBeEnabled();
});

test("refunded and partial say what happened", async ({ page }) => {
    await ethToUsdc(page);
    await openReview(page);
    await expect(reviewPanel(page).getByText("Fake Bridge")).toBeVisible();
    await confirmButton(page).click();
    await expect(reviewPanel(page).getByText("Swap sent.")).toBeVisible({ timeout: 15_000 });
    const [first] = await sentHashes(page);
    await setSwapStatus(first, "FAILED", { substatus: "REFUNDED" });
    await expect(
        reviewPanel(page).getByText(/^The swap didn't go through\. Your 0\.003\d* ETH is back on Ethereum\.$/),
    ).toBeVisible({ timeout: 30_000 });
    await reviewPanel(page).getByRole("button", { name: "Done" }).click();

    await openReview(page);
    await expect(reviewPanel(page).getByText("Fake Bridge")).toBeVisible();
    await confirmButton(page).click();
    await expect(reviewPanel(page).getByText("Swap sent.")).toBeVisible({ timeout: 15_000 });
    const second = (await sentHashes(page))[1];
    await setSwapStatus(second, "DONE", { substatus: "PARTIAL", receiving: { symbol: "USDT" } });
    await expect(reviewPanel(page).getByText(/^Received 9\.97\d* USDT on Ethereum instead of USDC\.$/)).toBeVisible({
        timeout: 30_000,
    });
});

test("receiving on Solana without a Solana wallet asks to connect one", async ({ page }) => {
    await page.goto("/");
    await connect(page);
    // The sentence starts as ETH to SOL, which lands on Solana.
    await openReview(page);
    await expect(reviewPanel(page).getByText("Connect a Solana wallet to receive SOL on Solana.")).toBeVisible();
    await expect(reviewPanel(page).getByRole("button", { name: "Connect", exact: true })).toBeVisible();
    await expect(reviewPanel(page).getByRole("button", { name: "Confirm swap" })).toHaveCount(0);
});

test("a paying wallet that is linked but not connected here asks to connect and opens no order", async ({ page }) => {
    // The person's other linked wallet is the active one; only the first is connected in this browser.
    const other = randomAddress();
    await mockPrivy(page, [other]);
    await page.addInitScript((address) => {
        const original = Storage.prototype.getItem;
        Storage.prototype.getItem = function (this: Storage, key: string) {
            return key.startsWith("active-wallet:")
                ? JSON.stringify({ kind: "evm", address })
                : original.call(this, key);
        };
    }, other);
    const orders: string[] = [];
    await page.routeWebSocket(/socket\.io/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => {
            if (typeof message === "string" && message.includes('"swap:order"')) orders.push(message);
            server.send(message);
        });
        server.onMessage((message) => ws.send(message));
    });
    await ethToUsdc(page);
    await openReview(page);
    const panel = reviewPanel(page);
    await expect(panel.getByText(`Connect ${other.slice(0, 6)}…${other.slice(-4)} to pay.`)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Confirm swap" })).toHaveCount(0);
    expect(orders).toHaveLength(0);
    expect(await sends(page)).toHaveLength(0);
});

test("a stale quote is never shown for a new amount", async ({ page, isMobile }) => {
    // The first quote's answer is held back while the amount changes, then let through.
    let hold = true;
    const held: string[] = [];
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket(/socket\.io/, (ws) => {
        const server = ws.connectToServer();
        socket = ws;
        ws.onMessage((message) => server.send(message));
        server.onMessage((message) => {
            if (hold && typeof message === "string" && message.startsWith("43") && message.includes('"toAmountMin"')) {
                held.push(message);
                return;
            }
            ws.send(message);
        });
    });
    await ethToUsdc(page);
    await openReview(page);
    await expect.poll(() => held.length).toBe(1);
    await expect(reviewPanel(page).getByText("Fake Bridge")).toHaveCount(0);
    hold = false;
    // A desktop keeps the review open beside the sentence; a phone's covers it.
    if (isMobile) await reviewPanel(page).getByRole("button", { name: "Close review" }).click();
    await setAmount(page, "20");
    if (isMobile) await openReview(page);
    await expect(reviewPanel(page).getByText(/^0\.006\d* ETH \(\$20\.00\) on Ethereum$/)).toBeVisible();
    // The answer for 10 USD arrives late.
    socket!.send(held[0]);
    await page.waitForTimeout(500);
    await expect(reviewPanel(page).getByText(/\(\$10\.00\)/)).toHaveCount(0);
    await expect(reviewPanel(page).getByText(/\(\$20\.00\)/)).toBeVisible();
});

test("buy and sell are swaps through USDC", async ({ page }) => {
    await fundSource(addressOf(page), "ethereum:USDC", "100");
    await page.goto("/");
    await connect(page);
    await trade(page).getByRole("button", { name: "Swap", exact: true }).click();
    await picker(page).getByRole("option", { name: /^Buy/ }).click();
    await expect(picker(page)).toBeHidden();
    await pickCoin(page, "term:token", "ETH", "Ethereum");
    await openReview(page);
    const panel = reviewPanel(page);
    // The purchase pays USDC on Ethereum for the coin there, approving it first.
    await expect(panel.getByText(/^10 USDC \(\$10\.00\) on Ethereum$/)).toBeVisible();
    await expect(panel.getByText(/^≈ 0\.003\d* ETH on Ethereum$/)).toBeVisible();
    await expect(panel.getByText("Approve USDC in your wallet, then confirm the swap.")).toBeVisible();
    await panel.getByRole("button", { name: "Confirm purchase" }).click();
    await expect(panel.getByText("Swap sent.")).toBeVisible({ timeout: 20_000 });
    expect(await sends(page)).toHaveLength(2);
    await panel.getByRole("button", { name: "Done" }).click();

    await trade(page).getByRole("button", { name: "Buy", exact: true }).click();
    await picker(page).getByRole("option", { name: /^Sell/ }).click();
    await expect(picker(page)).toBeHidden();
    await openReview(page);
    await expect(panel.getByText(/^0\.003\d* ETH \(\$10\.00\) on Ethereum$/)).toBeVisible();
    await expect(panel.getByText(/^≈ 9\.97\d* USDC on Ethereum$/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Confirm sale" })).toBeVisible();
});
