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

/** Where a scan says what it skipped or split; optional, since most callers have nobody to tell. */
export type ScanLog = {
    warn: (fields: object, message: string) => void;
    info: (fields: object, message: string) => void;
};

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

/** The transfers in the logs, saying so for each log that lacks a field a transfer needs. */
function toTransfers(logs: LogLike[], log: ScanLog | undefined): NativeTransfer[] {
    const found: NativeTransfer[] = [];
    for (const entry of logs) {
        const transfer = toTransfer(entry);
        if (transfer) found.push(transfer);
        else {
            const { from, to, value } = entry.args;
            const missing = [
                ["from", from],
                ["to", to],
                ["value", value],
                ["transactionHash", entry.transactionHash],
                ["logIndex", entry.logIndex],
                ["blockNumber", entry.blockNumber],
                ["blockHash", entry.blockHash],
            ].flatMap(([name, field]) => (field === undefined || field === null ? [name] : []));
            log?.warn(
                {
                    txHash: entry.transactionHash,
                    logIndex: entry.logIndex,
                    blockNumber: Number(entry.blockNumber),
                    missing,
                },
                "Skipped a transfer log with missing fields",
            );
        }
    }
    return found;
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
    log?: ScanLog,
): Promise<NativeTransfer[]> {
    if (recipients.length === 0 || fromBlock > toBlock) return [];
    const wanted = new Set(recipients.map((address) => address.toLowerCase()));

    const all = recipients.map((address) => getAddress(address));
    const chunks: (Address[] | undefined)[] =
        all.length <= ADDRESSES_PER_QUERY * MAX_FILTERED_QUERIES ? chunked(all) : [undefined];

    const found = new Map<string, NativeTransfer>();
    for (const to of chunks) {
        for (const transfer of await queryRange(client, to, fromBlock, toBlock, all, log)) {
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
    log?: ScanLog,
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
        return toTransfers(logs, log);
    } catch (error) {
        const text = errorText(error);
        if (THROTTLED.test(text)) {
            throw new Error(`Arc's RPC rate limited getLogs for blocks ${fromBlock}-${toBlock}: ${text.trim().slice(0, 200)}`, { cause: error });
        }
        if (!TOO_MUCH.test(text)) throw error;
        const reason = text.trim().slice(0, 200);
        if (fromBlock < toBlock) {
            log?.info(
                { op: "getLogs.split", fromBlock, toBlock, reason },
                "Arc's RPC found a block range too big, so the scan halves it",
            );
            const middle = Math.floor((fromBlock + toBlock) / 2);
            const first = await queryRange(client, to, fromBlock, middle, recipients, log);
            const second = await queryRange(client, to, middle + 1, toBlock, recipients, log);
            return [...first, ...second];
        }
        const narrower = to === undefined ? chunked(recipients) : halves(to);
        if (narrower.length < 2) {
            throw new Error(`Arc's RPC says block ${fromBlock} is too big to read even for one address: ${reason}`, {
                cause: error,
            });
        }
        log?.info(
            { op: "getLogs.split", fromBlock, toBlock, reason, parts: narrower.length },
            "Arc's RPC found one block too big, so the scan narrows it by address",
        );
        const parts = [];
        for (const part of narrower) {
            parts.push(...(await queryRange(client, part, fromBlock, toBlock, recipients, log)));
        }
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
