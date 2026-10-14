import { parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { DEPOSIT_FOR_BURN_EVENT, POLYGON, decodeBurnLog } from "./pool-moves.ts";

/** The viem client members the reader uses, so a test passes a hand-written stub. */
export type PolygonClient = Pick<
    PublicClient,
    "readContract" | "getLogs" | "getTransactionReceipt" | "getCode" | "getBlockNumber"
>;

export type PolygonReader = {
    /** Native USDC the owner holds, in 6-decimal units. */
    usdcBalanceE6(owner: Address): Promise<bigint>;
    hasCode(address: Address): Promise<boolean>;
    /** The wallet's TokenMessengerV2 burns in a block range that over-covers [since, now]; the caller matches amounts. */
    burnEvents(o: { wallet: Address; since: Date; now: Date }): Promise<{ txHash: Hex; amountE6: bigint }[]>;
    /** The wallet's DepositForBurn in that transaction's receipt; null when the receipt has none, a throw when it has no receipt yet. */
    burnLog(o: { wallet: Address; hash: Hex }): Promise<{ amountE6: bigint } | null>;
};

/** Blocks asked of eth_getLogs in one call, which a public RPC refuses to exceed by much. */
const LOG_RANGE_BLOCKS = 2_000n;
/** Blocks added before the window's estimated start, because block times are only known to be at least one second. */
const MARGIN_BLOCKS = 200n;

const erc20 = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Reads the pool wallet's Polygon side: its native USDC, its code and its CCTP burns. */
export function createPolygonReader(client: PolygonClient): PolygonReader {
    return {
        usdcBalanceE6: (owner) =>
            client.readContract({ address: POLYGON.usdc, abi: erc20, functionName: "balanceOf", args: [owner] }),

        async hasCode(address) {
            const code = await client.getCode({ address });
            return code !== undefined && code !== "0x";
        },

        async burnEvents({ wallet, since, now }) {
            const head = await client.getBlockNumber();
            const elapsed = BigInt(Math.max(0, Math.ceil((now.getTime() - since.getTime()) / 1000)));
            const first = head - elapsed - MARGIN_BLOCKS;
            const found: { txHash: Hex; amountE6: bigint }[] = [];
            for (let from = first < 0n ? 0n : first; from <= head; from += LOG_RANGE_BLOCKS) {
                const to = from + LOG_RANGE_BLOCKS - 1n < head ? from + LOG_RANGE_BLOCKS - 1n : head;
                const logs = await client.getLogs({
                    address: POLYGON.tokenMessenger,
                    event: DEPOSIT_FOR_BURN_EVENT,
                    args: { depositor: wallet },
                    fromBlock: from,
                    toBlock: to,
                });
                for (const log of logs) {
                    const burn = decodeBurnLog({ topics: log.topics, data: log.data });
                    if (burn && sameAddress(burn.depositor, wallet)) {
                        found.push({ txHash: log.transactionHash, amountE6: burn.amountE6 });
                    }
                }
            }
            return found;
        },

        async burnLog({ wallet, hash }) {
            const receipt = await client.getTransactionReceipt({ hash });
            for (const log of receipt.logs) {
                if (!sameAddress(log.address, POLYGON.tokenMessenger)) continue;
                const burn = decodeBurnLog({ topics: log.topics, data: log.data });
                if (burn && sameAddress(burn.depositor, wallet)) return { amountE6: burn.amountE6 };
            }
            return null;
        },
    };
}
