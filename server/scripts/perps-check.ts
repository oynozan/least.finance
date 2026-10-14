/**
 * Runs the whole perps path on the Hyperliquid testnet through the real adapter: fund a person's address from the
 * master, open, close and sweep back, and prints what it observed for the design's open questions 1 to 10.
 * It refuses to run unless HYPERLIQUID_API_URL is the testnet. The master needs testnet dollars (the faucet wants a
 * prior mainnet deposit from the same address): the first run prints a throwaway phrase and the master's address,
 * fund it and run again with PERPS_CHECK_MNEMONIC set to that phrase.
 *
 * Run it from server/ with `HYPERLIQUID_API_URL=https://api.hyperliquid-testnet.xyz node scripts/perps-check.ts`.
 */
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { createKeyring } from "../src/accounts/keyring.ts";
import { nextNonce } from "../src/perps/client.ts";
import { createNktkasClient } from "../src/perps/nktkas-client.ts";
import { limitPrice, liquidationPrice, roundSize, sizeFor } from "../src/perps/math.ts";
import { requireTestnet } from "./live-check-guards.ts";

const ASSET = "BTC";
const LEVERAGE = 5;
const COLLATERAL_E6 = 12_000_000n;
const FUND_E6 = 14_000_000n;
const MIN_MASTER_E6 = 30_000_000n;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const usd = (e6: bigint) => `${e6 < 0n ? "-" : ""}$${(Number(e6 < 0n ? -e6 : e6) / 1e6).toFixed(6)}`;
const observed = (question: string, answer: string) => console.log(`${question}\n    ${answer}`);

async function main() {
    const url = requireTestnet(process.env.HYPERLIQUID_API_URL);
    const phrase = process.env.PERPS_CHECK_MNEMONIC?.trim();
    if (!phrase) {
        const fresh = generateMnemonic(wordlist, 256);
        console.log(`Master address: ${createKeyring(fresh).perpAddressAt(0)}`);
        console.log(`Fund it on the testnet, then run again with PERPS_CHECK_MNEMONIC="${fresh}"`);
        return;
    }
    const keyring = createKeyring(phrase);
    const client = createNktkasClient({ url });
    const master = keyring.perpAddressAt(0);
    const person = keyring.perpAddressAt(1);
    const free = async (address: string) => (await client.state(address))?.withdrawableE6 ?? 0n;

    const masterStart = await free(master);
    if (masterStart < MIN_MASTER_E6) {
        console.log(`The master ${master} holds ${usd(masterStart)}; it needs ${usd(MIN_MASTER_E6)}.`);
        process.exitCode = 1;
        return;
    }

    // 1 to 3: funding a fresh address
    const sent = await client.usdSend(keyring.perpSignerAt(0), person, FUND_E6, nextNonce(master));
    await pause(2_000);
    const [masterAfter, personAfter] = [await free(master), await free(person)];
    observed(
        "1. Activation payer (who bears the 1 USDC)",
        `sent ${usd(FUND_E6)} -> ${sent.kind}; master -${usd(masterStart - masterAfter)}, person +${usd(personAfter)}`,
    );
    observed("2. usdSend fee", `master paid ${usd(masterStart - masterAfter - FUND_E6)} beyond the amount`);
    observed(
        "3. Does usdSend move the perp balance / account mode",
        `person's perp withdrawable ${usd(personAfter)} right after the send (nonzero means the perp balance, as in a standard account)`,
    );

    // 9: the same nonce again
    const nonce = nextNonce(master);
    const first = await client.usdSend(keyring.perpSignerAt(0), person, 1_000_000n, nonce);
    const again = await client.usdSend(keyring.perpSignerAt(0), person, 1_000_000n, nonce);
    observed("9. Duplicate nonce", `first ${first.kind}, repeat ${JSON.stringify(again)}`);

    // Open
    const meta = (await client.meta()).assets.find((a) => a.asset === ASSET)!;
    const sizing = sizeFor({
        collateralE6: COLLATERAL_E6,
        leverage: LEVERAGE,
        feeRate: (await client.userFees(person)).takerRate,
        ourFeeRate: 0,
        price: meta.markPx,
        szDecimals: meta.szDecimals,
    })!;
    await client.updateLeverage(keyring.perpSignerAt(1), ASSET, LEVERAGE);
    const before = await free(person);
    const opened = await client.order(keyring.perpSignerAt(1), {
        asset: ASSET,
        isBuy: true,
        px: limitPrice(meta.markPx, "long", "open", 100, meta.szDecimals),
        sz: sizing.sizeCoin,
        reduceOnly: false,
        cloid: `0x${"1".repeat(32)}`,
    });
    await pause(2_000);
    const state = (await client.state(person))!;
    const position = state.positions.find((p) => p.asset === ASSET);
    if (!position) {
        console.log(`The order did not open a position: ${JSON.stringify(opened)}`);
        process.exitCode = 1;
        return;
    }
    const entry = Number(position.entryPx);
    const size = Number(position.sizeCoin);
    observed(
        "5. Margin basis",
        `margin used ${usd(position.marginUsedE6)}; notional at fill / leverage ${((entry * size) / LEVERAGE).toFixed(6)}; at the limit price ${((Number(limitPrice(meta.markPx, "long", "open", 100, meta.szDecimals)) * size) / LEVERAGE).toFixed(6)}`,
    );
    observed(
        "6. Entry fee taken from",
        `withdrawable fell ${usd(before - state.withdrawableE6)}; margin ${usd(position.marginUsedE6)}; the rest is the fee (${usd(before - state.withdrawableE6 - position.marginUsedE6)})`,
    );
    const formula = liquidationPrice({
        side: "long",
        entry,
        sizeCoin: size,
        marginUSD: Number(position.marginUsedE6) / 1e6,
        notionalUSD: entry * size,
        maxLeverage: meta.maxLeverage,
    });
    observed("7. Liquidation formula", `formula ${formula.toFixed(2)} against liquidationPx ${position.liquidationPx}`);
    const fills = await client.fills(person, Date.now() - 600_000);
    observed(
        "8. REST liquidation field",
        `the adapter reads it as a boolean; this account's fills show liquidation=${fills.map((f) => f.liquidation).join(",")} (a real liquidation is the only way to see it set)`,
    );

    // 4: a reduce-only close under $10, then the rest
    const tiny = roundSize(4 / meta.markPx, meta.szDecimals);
    const closePx = limitPrice(meta.markPx, "long", "close", 300, meta.szDecimals);
    const partial = await client.order(keyring.perpSignerAt(1), {
        asset: ASSET,
        isBuy: false,
        px: closePx,
        sz: tiny,
        reduceOnly: true,
        cloid: `0x${"2".repeat(32)}`,
    });
    observed("4. Reduce-only minimum", `closing about $4 reduce-only -> ${JSON.stringify(partial)}`);
    const rest = (await client.state(person))!.positions.find((p) => p.asset === ASSET);
    if (rest) {
        const closed = await client.order(keyring.perpSignerAt(1), {
            asset: ASSET,
            isBuy: false,
            px: closePx,
            sz: rest.sizeCoin,
            reduceOnly: true,
            cloid: `0x${"3".repeat(32)}`,
        });
        console.log(`Closed the rest: ${JSON.stringify(closed)}`);
    }

    // Sweep back
    await pause(2_000);
    const swept = await free(person);
    const back = await client.usdSend(keyring.perpSignerAt(1), master, swept, nextNonce(person));
    await pause(2_000);
    console.log(
        `Swept ${usd(swept)} back: ${back.kind}; person now ${usd(await free(person))}, master ${usd(await free(master))} (started ${usd(masterStart)})`,
    );
    observed(
        "10. Master rate limit",
        "not observable from one run; watch the master's request budget after many sends on mainnet",
    );
}

await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
