/**
 * Records real Relay and Across answers as the fixtures the provider tests run on. These are a quote for 0.01 ETH
 * from Ethereum and for 10 USDT from BNB Chain to Arc, and the status of a request that has been filled. It only
 * asks and never signs or sends anything.
 *
 * Run it from server/ with `node --env-file-if-exists=.env scripts/record-bridge-fixtures.ts`, then format the
 * result from the repo root with `npx prettier --write server/test/fixtures`. RELAY_API_KEY and ACROSS_INTEGRATOR_ID
 * are used when set, and both providers also answer without them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { zeroAddress } from "viem";
import { coinByKey, parseCoinAmount } from "../src/crosschain/catalog.ts";

// Throwaway addresses the quotes are made for, the provider tests expect these
const WALLET = "0x00000000000000000000000000000000000a11ce";
const DEPOSIT_ADDRESS = "0x00000000000000000000000000000000000de905";
const ARC_CHAIN_ID = 5042;
const ARC_USDC = "0x3600000000000000000000000000000000000000";

const QUOTES = [
    { file: "quote-eth.json", coin: coinByKey("ethereum:ETH"), amount: "0.01" },
    { file: "quote-bnb-usdt.json", coin: coinByKey("bnb:USDT"), amount: "10" },
];

// Ethereum to Arc bridges found filled on 2026-10-09, kept to fetch a status for
const RELAY_FILLED_REQUEST = "0x179156429202aa755b4c9c25b4fc8065fcc2d613770e06cb89bf3327f86e355b";
const ACROSS_FILLED_DEPOSIT = {
    originChainId: 1,
    depositTxHash: "0x20e25fd9ac63939066c4c5ddd52c13b8682bf2d39653f761af428c1f68c9b851",
};

const relayKey = process.env.RELAY_API_KEY;
const acrossIntegratorId = process.env.ACROSS_INTEGRATOR_ID;

async function answer(response: Response): Promise<unknown> {
    if (!response.ok) throw new Error(`${response.url} answered ${response.status}: ${await response.text()}`);
    return response.json();
}

function save(provider: string, file: string, body: unknown) {
    const directory = new URL(`../test/fixtures/${provider}/`, import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL(file, directory), `${JSON.stringify(body, null, 4)}\n`);
    console.log(`recorded ${provider}/${file}`);
}

const relayHeaders: Record<string, string> = { "content-type": "application/json" };
if (relayKey) relayHeaders["x-api-key"] = relayKey;

for (const { file, coin, amount } of QUOTES) {
    const relay = await fetch("https://api.relay.link/quote/v2", {
        method: "POST",
        headers: relayHeaders,
        body: JSON.stringify({
            user: WALLET,
            recipient: DEPOSIT_ADDRESS,
            refundTo: WALLET,
            originChainId: coin.chainId,
            destinationChainId: ARC_CHAIN_ID,
            originCurrency: coin.token ?? zeroAddress,
            destinationCurrency: ARC_USDC,
            amount: String(parseCoinAmount(coin, amount)),
            tradeType: "EXACT_INPUT",
        }),
    });
    save("relay", file, await answer(relay));

    const acrossQuery = new URLSearchParams({
        tradeType: "exactInput",
        amount: String(parseCoinAmount(coin, amount)),
        inputToken: coin.token ?? zeroAddress,
        outputToken: ARC_USDC,
        originChainId: String(coin.chainId),
        destinationChainId: String(ARC_CHAIN_ID),
        depositor: WALLET,
        recipient: DEPOSIT_ADDRESS,
        refundAddress: WALLET,
    });
    if (acrossIntegratorId) acrossQuery.set("integratorId", acrossIntegratorId);
    save("across", file, await answer(await fetch(`https://app.across.to/api/swap/approval?${acrossQuery}`)));
}

const relayStatus = await fetch(
    `https://api.relay.link/intents/status/v3?${new URLSearchParams({ requestId: RELAY_FILLED_REQUEST })}`,
    { headers: relayKey ? { "x-api-key": relayKey } : {} },
);
save("relay", "status-filled.json", await answer(relayStatus));

const acrossStatus = await fetch(
    `https://app.across.to/api/deposit/status?${new URLSearchParams({
        originChainId: String(ACROSS_FILLED_DEPOSIT.originChainId),
        depositTxHash: ACROSS_FILLED_DEPOSIT.depositTxHash,
    })}`,
);
save("across", "status-filled.json", await answer(acrossStatus));
