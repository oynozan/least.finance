import { erc20Abi, formatUnits, type Address, type PublicClient } from "viem";
import type { Keyring } from "../accounts/keyring.ts";
import type { Collections } from "../db/mongo.ts";
import { fromDecimal } from "../db/money.ts";
import type { SolanaRpc } from "../crosschain/solana.ts";
import { scrubUrls } from "../logger.ts";
import { POLYGON } from "../predictions/pool-moves.ts";
import { COINS, NATIVE_EVM, NATIVE_SOLANA, NETWORKS } from "../swaps/coins.ts";
import type { EvmNetworkId } from "../swaps/clients.ts";
import { usdFromE6, usdFromUnits, usdFromWei } from "./units.ts";

export type HeldWallet = {
    id: "treasury" | "deposits" | "pool" | "hyperliquid" | "inventoryEvm" | "inventorySolana" | "transit";
    label: string;
    network: string;
    address: string | null;
    usd: number;
    parts: { symbol: string; amount: string; usd: number | null }[];
    error: string | null;
};

/** The label and network of each wallet, the one place they are written. */
export const WALLETS: Record<HeldWallet["id"], { label: string; network: string }> = {
    treasury: { label: "Arc treasury", network: "Arc" },
    deposits: { label: "Deposit addresses", network: "Arc" },
    pool: { label: "Polymarket pool", network: "Polygon" },
    hyperliquid: { label: "Hyperliquid float", network: "Hyperliquid" },
    inventoryEvm: { label: "Coin inventory (EVM)", network: "EVM" },
    inventorySolana: { label: "Coin inventory (Solana)", network: "Solana" },
    transit: { label: "In transit", network: "Bridge" },
};

export type HeldReaders = Record<HeldWallet["id"], () => Promise<HeldWallet>>;

type Deps = {
    keyring: Keyring;
    collections: Collections;
    arc: PublicClient;
    polygon: PublicClient;
    evm: Record<EvmNetworkId, PublicClient>;
    solana: SolanaRpc;
    hyperliquid: {
        state(address: string): Promise<{ accountValueE6: bigint } | null>;
        spotUsdcE6(address: string): Promise<bigint>;
    };
    poolWallet: () => string | null;
    priceOf: (symbol: string) => number | null;
};

const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
const ARC_READS_AT_ONCE = 10;
/** A move that has been forwarding this long is no longer money in flight. */
const IN_FLIGHT_MAX_MS = 3_600_000;

/** The coins an EVM network's gas is paid in that no `COINS` entry covers. */
const EXTRA_NATIVE: Partial<Record<EvmNetworkId, string>> = { polygon: "POL", arc: "USDC" };

/** The first line of an error with every URL cut to its host. */
const reason = (error: unknown) =>
    scrubUrls(error instanceof Error ? error.message : String(error))
        .split("\n")[0]!
        .slice(0, 200);

/** One reader per wallet we hold money in; each catches its own errors, so none throws. */
export function heldReaders(deps: Deps): HeldReaders {
    const guarded =
        (
            wallet: Omit<HeldWallet, "usd" | "parts" | "error">,
            read: () => Promise<{ usd: number; parts?: HeldWallet["parts"] }>,
        ) =>
        async (): Promise<HeldWallet> => {
            try {
                const { usd, parts = [] } = await read();
                return { ...wallet, usd, parts, error: null };
            } catch (error) {
                return { ...wallet, usd: 0, parts: [], error: reason(error) };
            }
        };

    // A coin's raw units (any decimals) at its price; null with no price.
    const priced = (symbol: string, raw: bigint, decimals: number) => {
        const price = deps.priceOf(symbol);
        const amount = formatUnits(raw, decimals);
        return {
            part: {
                symbol,
                amount,
                usd: price === null ? null : usdFromUnits(raw * 10n ** BigInt(18 - decimals)) * price,
            },
        };
    };
    const total = (parts: HeldWallet["parts"]) => parts.reduce((sum, p) => sum + (p.usd ?? 0), 0);

    const treasury = deps.keyring.operator().address;
    const hlMaster = deps.keyring.perpAddressAt(0);
    const inventory = deps.keyring.inventoryEvm().address;
    const solanaInventory = deps.keyring.inventorySolana().address;

    return {
        treasury: guarded({ id: "treasury", ...WALLETS.treasury, address: treasury }, async () => ({
            usd: usdFromWei(await deps.arc.getBalance({ address: treasury })),
        })),

        deposits: guarded({ id: "deposits", ...WALLETS.deposits, address: null }, async () => {
            const rows = await deps.collections.accounts.find({}, { projection: { depositAddress: 1 } }).toArray();
            let wei = 0n;
            for (let at = 0; at < rows.length; at += ARC_READS_AT_ONCE) {
                const balances = await Promise.all(
                    rows
                        .slice(at, at + ARC_READS_AT_ONCE)
                        .map((row) => deps.arc.getBalance({ address: row.depositAddress as Address })),
                );
                for (const balance of balances) wei += balance;
            }
            return { usd: usdFromWei(wei) };
        }),

        pool: async () => {
            const address = deps.poolWallet();
            const wallet = { id: "pool" as const, ...WALLETS.pool, address };
            if (!address) return { ...wallet, usd: 0, parts: [], error: "Not set up" };
            return guarded(wallet, async () => {
                const read = (token: Address) =>
                    deps.polygon.readContract({
                        address: token,
                        abi: erc20Abi,
                        functionName: "balanceOf",
                        args: [address as Address],
                    });
                const [pusd, usdc, usdce] = await Promise.all([read(POLYGON.pusd), read(POLYGON.usdc), read(USDC_E)]);
                const parts = [
                    { symbol: "pUSD", amount: formatUnits(pusd, 6), usd: usdFromE6(pusd) },
                    { symbol: "USDC", amount: formatUnits(usdc, 6), usd: usdFromE6(usdc) },
                    { symbol: "USDC.e", amount: formatUnits(usdce, 6), usd: usdFromE6(usdce) },
                ];
                return { usd: usdFromE6(pusd + usdc + usdce), parts };
            })();
        },

        hyperliquid: guarded({ id: "hyperliquid", ...WALLETS.hyperliquid, address: hlMaster }, async () => {
            const [perps, spot] = await Promise.all([
                deps.hyperliquid.state(hlMaster),
                deps.hyperliquid.spotUsdcE6(hlMaster),
            ]);
            const perpsE6 = perps?.accountValueE6 ?? 0n;
            return {
                usd: usdFromE6(perpsE6 + spot),
                parts: [
                    { symbol: "Perps", amount: formatUnits(perpsE6, 6), usd: usdFromE6(perpsE6) },
                    { symbol: "Spot", amount: formatUnits(spot, 6), usd: usdFromE6(spot) },
                ],
            };
        }),

        inventoryEvm: guarded({ id: "inventoryEvm", ...WALLETS.inventoryEvm, address: inventory }, async () => {
            const parts: HeldWallet["parts"] = [];
            // One network at a time, so a public RPC isn't hit by every network's tokens at once.
            for (const network of NETWORKS) {
                if (network.kind !== "evm") continue;
                const id = network.id as EvmNetworkId;
                const client = deps.evm[id];
                const reads: Promise<ReturnType<typeof priced>>[] = [];
                const extra = EXTRA_NATIVE[id];
                if (extra) {
                    reads.push(client.getBalance({ address: inventory }).then((raw) => priced(extra, raw, 18)));
                }
                for (const coin of COINS) {
                    for (const entry of coin.entries) {
                        if (entry.network !== id) continue;
                        if (entry.address === NATIVE_EVM) {
                            reads.push(
                                client.getBalance({ address: inventory }).then((raw) => priced(coin.symbol, raw, 18)),
                            );
                        } else if (id === "arc" && coin.symbol === "USDC") {
                            // Arc's USDC ERC-20 mirrors the native balance already read above.
                            continue;
                        } else {
                            reads.push(
                                client
                                    .readContract({
                                        address: entry.address as Address,
                                        abi: erc20Abi,
                                        functionName: "balanceOf",
                                        args: [inventory],
                                    })
                                    .then((raw) => priced(coin.symbol, raw, entry.decimals)),
                            );
                        }
                    }
                }
                for (const { part } of await Promise.all(reads)) if (part.amount !== "0") parts.push(part);
            }
            return { usd: total(parts), parts };
        }),

        inventorySolana: guarded(
            { id: "inventorySolana", ...WALLETS.inventorySolana, address: solanaInventory },
            async () => {
                const reads: Promise<ReturnType<typeof priced>>[] = [];
                for (const coin of COINS) {
                    for (const entry of coin.entries) {
                        if (entry.network !== "solana") continue;
                        const read =
                            entry.address === NATIVE_SOLANA
                                ? deps.solana.getBalance(solanaInventory)
                                : deps.solana.getTokenBalance(solanaInventory, entry.address);
                        reads.push(read.then((raw) => priced(coin.symbol, raw, entry.decimals)));
                    }
                }
                const parts = (await Promise.all(reads)).map((r) => r.part).filter((p) => p.amount !== "0");
                return { usd: total(parts), parts };
            },
        ),

        transit: guarded({ id: "transit", ...WALLETS.transit, address: null }, async () => {
            const since = new Date(Date.now() - IN_FLIGHT_MAX_MS);
            const [moves, perps] = await Promise.all([
                deps.collections.poolRebalances
                    .find({ kind: "move", state: "forwarding", updatedAt: { $gt: since } })
                    .toArray(),
                deps.collections.perpRebalances.find({ state: "sent", createdAt: { $gt: since } }).toArray(),
            ]);
            let e6 = 0n;
            for (const row of moves) e6 += fromDecimal(row.amountE6) - fromDecimal(row.maxFeeE6);
            for (const row of perps) e6 += fromDecimal(row.amountE6);
            return { usd: usdFromE6(e6) };
        }),
    };
}
