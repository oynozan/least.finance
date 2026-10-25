import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";

/** A decimal string such as "2.5" as E6, cut at the sixth place. */
export function decimalToE6(value: string): bigint {
    const [whole = "0", fraction = ""] = value.split(".");
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}

/** Reads the USDC in an address's Spot balance, which the perps clearinghouse read doesn't show. */
export function createSpotReader(apiUrl: string) {
    const info = new InfoClient({
        transport: new HttpTransport({ apiUrl, isTestnet: new URL(apiUrl).hostname.includes("testnet") }),
    });
    return async (address: string): Promise<bigint> => {
        const spot = await info.spotClearinghouseState({ user: address as `0x${string}` });
        const usdc = spot.balances.find((b) => b.coin === "USDC");
        return usdc ? decimalToE6(usdc.total) : 0n;
    };
}
