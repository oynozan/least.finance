import { getAddress, isAddressEqual, parseEventLogs, type Address, type Hash, type TransactionReceipt } from "viem";
import { NATIVE_TRANSFER_EMITTER, transferEvent, type ArcClient } from "./arc.ts";

/** One movement of native USDC, as Arc logs it. */
export type NativeTransfer = {
    txHash: Hash;
    logIndex: number;
    blockNumber: number;
    blockHash: Hash;
    /** Lowercase, like every hash and address here. */
    from: Address;
    /** Lowercase. */
    to: Address;
    /** In wei: 18 decimals. */
    value: bigint;
};

/** RPCs reject an `eth_getLogs` OR-filter past about this many addresses. */
const ADDRESSES_PER_QUERY = 100;
/** Past this many queries per range, one unfiltered query and a local match is cheaper. */
const MAX_FILTERED_QUERIES = 4;

/** Errors that mean "ask for less", worded differently by every RPC. */
const TOO_MUCH = /range|max results|too (large|many|big)|limit|exceed|response size/i;
/** Being throttled reads a lot like the above, but splitting would only make it worse. */
const THROTTLED = /rate.?limit|too many requests|\b429\b/i;

type LogLike = {
    transactionHash: Hash | null;
    logIndex: number | null;
    blockNumber: bigint | null;
    blockHash: Hash | null;
    args: { from?: Address; to?: Address; value?: bigint };
};

function toTransfer(log: LogLike): NativeTransfer | null {
    const { from, to, value } = log.args;
    if (!from || !to || value === undefined) return null;
    if (log.transactionHash === null || log.logIndex === null || log.blockNumber === null || log.blockHash === null) {
        return null;
    }
    return {
        txHash: log.transactionHash.toLowerCase() as Hash,
        logIndex: log.logIndex,
        blockNumber: Number(log.blockNumber),
        blockHash: log.blockHash.toLowerCase() as Hash,
        from: from.toLowerCase() as Address,
        to: to.toLowerCase() as Address,
        value,
    };
}

const byChainOrder = (a: NativeTransfer, b: NativeTransfer) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;

/** Native transfers a receipt records, in log order. Gas isn't among them. */
export function transfersInReceipt(receipt: TransactionReceipt): NativeTransfer[] {
    const logs = receipt.logs.filter((log) => isAddressEqual(log.address, NATIVE_TRANSFER_EMITTER));
    return parseEventLogs({ abi: [transferEvent], logs, strict: true })
        .map(toTransfer)
        .filter((transfer) => transfer !== null)
        .sort(byChainOrder);
}

/**
 * Native transfers into any of `recipients` within a block range, in chain
 * order. Ranges an RPC finds too big are halved until they pass.
 */
export async function findTransfersTo(
    client: ArcClient,
    recipients: readonly Address[],
    fromBlock: number,
    toBlock: number,
): Promise<NativeTransfer[]> {
    if (recipients.length === 0 || fromBlock > toBlock) return [];
    const wanted = new Set(recipients.map((address) => address.toLowerCase()));

    const all = recipients.map((address) => getAddress(address));
    const chunks: (Address[] | undefined)[] =
        all.length <= ADDRESSES_PER_QUERY * MAX_FILTERED_QUERIES ? chunked(all) : [undefined];

    const found = new Map<string, NativeTransfer>();
    for (const to of chunks) {
        for (const transfer of await queryRange(client, to, fromBlock, toBlock, all)) {
            if (wanted.has(transfer.to)) found.set(`${transfer.txHash}:${transfer.logIndex}`, transfer);
        }
    }
    return [...found.values()].sort(byChainOrder);
}

const chunked = (addresses: Address[]) => {
    const chunks: Address[][] = [];
    for (let i = 0; i < addresses.length; i += ADDRESSES_PER_QUERY) {
        chunks.push(addresses.slice(i, i + ADDRESSES_PER_QUERY));
    }
    return chunks;
};

/**
 * Logs for `to` (every recipient when undefined) over a block range. Too
 * much for the RPC, it halves the range; a single block that's still too
 * much (a busy block, or an airdrop) is narrowed by recipient instead, so no
 * block can stall the scan.
 */
async function queryRange(
    client: ArcClient,
    to: Address[] | undefined,
    fromBlock: number,
    toBlock: number,
    recipients: Address[],
): Promise<NativeTransfer[]> {
    try {
        const logs = await client.getLogs({
            address: NATIVE_TRANSFER_EMITTER,
            event: transferEvent,
            args: to ? { to } : undefined,
            fromBlock: BigInt(fromBlock),
            toBlock: BigInt(toBlock),
            strict: true,
        });
        return logs.map(toTransfer).filter((transfer) => transfer !== null);
    } catch (error) {
        const text = errorText(error);
        if (THROTTLED.test(text) || !TOO_MUCH.test(text)) throw error;
        if (fromBlock < toBlock) {
            const middle = Math.floor((fromBlock + toBlock) / 2);
            const first = await queryRange(client, to, fromBlock, middle, recipients);
            const second = await queryRange(client, to, middle + 1, toBlock, recipients);
            return [...first, ...second];
        }
        const narrower = to === undefined ? chunked(recipients) : halves(to);
        if (narrower.length < 2) throw error;
        const parts = [];
        for (const part of narrower) parts.push(...(await queryRange(client, part, fromBlock, toBlock, recipients)));
        return parts;
    }
}

const halves = (addresses: Address[]) => {
    if (addresses.length < 2) return [addresses];
    const middle = Math.ceil(addresses.length / 2);
    return [addresses.slice(0, middle), addresses.slice(middle)];
};

function errorText(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    const details = (error as { details?: unknown }).details;
    return `${error.message} ${typeof details === "string" ? details : ""}`;
}
