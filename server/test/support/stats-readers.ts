import type { HeldReaders, HeldWallet } from "../../src/stats/held.ts";

const wallet = (
    id: HeldWallet["id"],
    label: string,
    network: string,
    usd: number,
    parts: HeldWallet["parts"] = [],
    address: string | null = null,
): (() => Promise<HeldWallet>) => {
    return async () => ({ id, label, network, address, usd, parts, error: null });
};

/** Fixed wallets with money in them, so a server under test reads no public RPC. */
export function fakeStatsReaders(): HeldReaders {
    return {
        treasury: wallet("treasury", "Arc treasury", "Arc", 1500, [], "0x00000000000000000000000000000000000000b1"),
        deposits: wallet("deposits", "Deposit addresses", "Arc", 250),
        pool: wallet("pool", "Polymarket pool", "Polygon", 300, [
            { symbol: "pUSD", amount: "250", usd: 250 },
            { symbol: "USDC", amount: "50", usd: 50 },
        ]),
        hyperliquid: wallet("hyperliquid", "Hyperliquid float", "Hyperliquid", 400, [
            { symbol: "Perps", amount: "300", usd: 300 },
            { symbol: "Spot", amount: "100", usd: 100 },
        ]),
        inventoryEvm: wallet("inventoryEvm", "Coin inventory (EVM)", "EVM", 120, [
            { symbol: "ETH", amount: "0.03", usd: 96.3 },
            { symbol: "USDC", amount: "23.7", usd: 23.7 },
        ]),
        inventorySolana: wallet("inventorySolana", "Coin inventory (Solana)", "Solana", 30, [
            { symbol: "SOL", amount: "0.2", usd: 29.44 },
        ]),
        transit: wallet("transit", "In transit", "Bridge", 0),
    };
}
