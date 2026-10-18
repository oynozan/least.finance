/**
 * Moves USDC between the Arc treasury and the master Hyperliquid float. Run it from server/ while the server is up,
 * but never while the server is paying a withdrawal or moving the pool: both sign from the treasury key, so it refuses
 * while a withdrawal is sending or a pool move is queued, sending or submitting. With POOL_REBALANCE=on, stop the
 * server or restart it with POOL_REBALANCE=off before running it, because the server can start a pool move between
 * this script's check and its send.
 *
 *   node --env-file=.env scripts/perps-rebalance.ts arc-to-hl <usd> [--reserve <usd>] [--yes-send-real-money]
 *   node --env-file=.env scripts/perps-rebalance.ts hl-to-arc <usd> [--yes-send-real-money]
 *   node --env-file=.env scripts/perps-rebalance.ts arrived <rebalanceId>
 *
 * It prints both sides and what it would do; nothing is sent without --yes-send-real-money. arc-to-hl needs
 * HYPERCORE_CCTP_FORWARDER, the CctpForwarder address on HyperEVM from Circle's HyperCore contract page. The
 * hl-to-arc forwarding data and Arc as its destination are unverified (design question 11): try $5 first, and
 * if it fails, withdraw to HyperEVM and burn there to Arc. A row stays `sent` until `arrived` marks it; the
 * reconciler stops counting a `sent` row after an hour and logs an error for it.
 */
import { concatHex, formatUnits, keccak256, pad, parseGwei, parseUnits, toHex, type Address, type Hex } from "viem";
import { createKeyring } from "../src/accounts/keyring.ts";
import { ARC_CHAIN_ID, MIN_BASE_FEE, createArcClient } from "../src/chain/arc.ts";
import { loadConfig } from "../src/config.ts";
import { feeUnits } from "../src/crosschain/iris.ts";
import { connectDatabase, type Collections, type PerpRebalanceDoc } from "../src/db/mongo.ts";
import { e6ToWei, fromDecimal, toDecimal, weiToE6 } from "../src/db/money.ts";
import { FORWARD_HOOK_DATA, ARC_USDC_ERC20, TOKEN_MESSENGER_V2, encodeApprove } from "../src/withdrawals/cctp-burn.ts";
import { TREASURY_GAS_RESERVE } from "../src/withdrawals/withdrawals.ts";
import { createNktkasClient, sendToEvmWithData } from "../src/perps/nktkas-client.ts";
import { nextNonce } from "../src/perps/client.ts";
import { ObjectId, type Collection, type Decimal128 } from "mongodb";
import { encodeFunctionData, parseAbi } from "viem";
import { describeError } from "./describe-error.ts";

const HYPEREVM_DOMAIN = 19;
const ARC_DOMAIN = 26;
/** The perps dex in the HyperCore forwarding hook. */
const PERPS_DEX = 0;
const STANDARD_FINALITY = 2000;
const APPROVE_GAS = 120_000n;
const BURN_GAS = 600_000n;
const PRIORITY_FEE = parseGwei("1");
const WITHDRAW_GAS_LIMIT = 200_000;

export type Direction = "arc-to-hl" | "hl-to-arc";

/** Whether a rebalance may go ahead: arc-to-hl must leave the treasury holding what withdrawals need. */
export function planRebalance(o: {
    direction: Direction;
    amountE6: bigint;
    treasuryFreeE6: bigint;
    withdrawalNeedE6: bigint;
}): { ok: true } | { ok: false; reason: string } {
    if (o.amountE6 <= 0n) return { ok: false, reason: "The amount must be above zero." };
    if (o.direction === "hl-to-arc") return { ok: true };
    if (o.treasuryFreeE6 - o.amountE6 < o.withdrawalNeedE6) {
        return { ok: false, reason: "That would leave the Arc treasury below what withdrawals need." };
    }
    return { ok: true };
}

/** Circle's forwarding hook for a HyperCore deposit: the magic, version 0, a 24-byte payload of the master's address and the perps dex. */
export function buildHookData(master: string): Hex {
    return concatHex([
        FORWARD_HOOK_DATA.slice(0, 2 + 56) as Hex,
        toHex(24, { size: 4 }),
        pad(master as Hex, { size: 20, dir: "left" }),
        toHex(PERPS_DEX, { size: 4 }),
    ]);
}

/** Circle's forwarding hook for a withdrawal minted on `domain`: the magic, version 0 and the domain as the payload. */
export function buildWithdrawData(domain: number): Hex {
    return concatHex([FORWARD_HOOK_DATA.slice(0, 2 + 56) as Hex, toHex(4, { size: 4 }), toHex(domain, { size: 4 })]);
}

type FeeRow = { finalityThreshold?: number; minimumFee?: number; forwardFee?: Record<string, number | string> };

/** The most Circle may take for an Arc to HyperCore burn: the highest quoted forwarding fee and the protocol's basis points; whole numbers are 6-decimal units, fractions are dollars. */
export function maxFeeOf(amountE6: bigint, row: FeeRow): bigint {
    const quoted = row.forwardFee?.high;
    if (quoted === undefined) throw new Error("Circle quoted no forwarding fee");
    const protocol = (amountE6 * BigInt(Math.ceil((row.minimumFee ?? 0) * 100))) / 1_000_000n + 1n;
    return feeUnits(quoted) + protocol;
}

const BURN_ABI = parseAbi([
    "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

/** Runs `record` only for a mined burn, so a reverted one never counts as money in flight. */
export async function recordIfMined(status: string, record: () => Promise<void>): Promise<boolean> {
    if (status !== "success") return false;
    await record();
    return true;
}

/** Marks a `sent` rebalance `arrived`; false when no such row is waiting. */
export async function markArrived(
    collection: Pick<Collection<PerpRebalanceDoc>, "updateOne">,
    id: string,
): Promise<boolean> {
    if (!ObjectId.isValid(id)) throw new Error("That is not a rebalance id.");
    const result = await collection.updateOne({ _id: new ObjectId(id), state: "sent" }, { $set: { state: "arrived" } });
    return result.modifiedCount === 1;
}

/** Why the script must not run now, or null: it signs from the treasury key, as a withdrawal and a pool top-up do. */
export function refusalReason(o: { sendingWithdrawals: number; busyPoolRows: number }): string | null {
    const reasons = [
        o.sendingWithdrawals > 0 &&
            `${o.sendingWithdrawals} withdrawal(s) are being paid from the treasury key; wait until they are paid`,
        o.busyPoolRows > 0 &&
            `${o.busyPoolRows} pool move(s) are queued, sending or submitting; with POOL_REBALANCE=on, stop the server or restart it with POOL_REBALANCE=off, then run this again`,
    ].filter(Boolean);
    return reasons.length > 0 ? `Not running: ${reasons.join("; ")}.` : null;
}

/** The withdrawals sending and the pool rows queued, sending or submitting, the work that signs from the treasury key. */
export async function countBusy(collections: Pick<Collections, "withdrawals" | "poolRebalances">) {
    const [sendingWithdrawals, busyPoolRows] = await Promise.all([
        collections.withdrawals.countDocuments({ state: "sending" }),
        collections.poolRebalances.countDocuments({ state: { $in: ["queued", "sending", "submitting"] } }),
    ]);
    return { sendingWithdrawals, busyPoolRows };
}

/** Wei the treasury still owes out: the withdrawals sending plus the pool top-ups sending (E6 turned into wei). */
export function owedOf(o: { withdrawals: { amount: Decimal128 }[]; poolRows: { amountE6: Decimal128 }[] }): bigint {
    const withdrawing = o.withdrawals.reduce((sum, doc) => sum + fromDecimal(doc.amount), 0n);
    return o.poolRows.reduce((sum, doc) => sum + e6ToWei(fromDecimal(doc.amountE6)), withdrawing);
}

const dollars = (e6: bigint) => `$${formatUnits(e6, 6)}`;

async function main() {
    const [direction, amountArg, ...rest] = process.argv.slice(2);
    if (direction === "arrived") {
        if (!amountArg) {
            console.error("Usage: perps-rebalance.ts arrived <rebalanceId>");
            process.exit(1);
        }
        const config = loadConfig();
        const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
        try {
            const marked = await markArrived(database.collections.perpRebalances, amountArg);
            console.log(marked ? "Marked arrived." : "No sent rebalance has that id.");
            if (!marked) process.exitCode = 1;
        } finally {
            await database.close();
        }
        return;
    }
    if ((direction !== "arc-to-hl" && direction !== "hl-to-arc") || !amountArg) {
        console.error("Usage: perps-rebalance.ts arc-to-hl|hl-to-arc <usd> [--reserve <usd>] [--yes-send-real-money]");
        process.exit(1);
    }
    const amountE6 = parseUnits(amountArg, 6);
    const send = rest.includes("--yes-send-real-money");
    const reserveAt = rest.indexOf("--reserve");
    const reserveE6 = reserveAt >= 0 ? parseUnits(rest[reserveAt + 1] ?? "0", 6) : 0n;

    const config = loadConfig();
    const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
    try {
        const refusal = refusalReason(await countBusy(database.collections));
        if (refusal) {
            console.error(refusal);
            process.exitCode = 1;
            return;
        }
        const keyring = createKeyring(config.DEPOSIT_MNEMONIC);
        const arc = createArcClient(config.ARC_RPC_URLS);
        const hl = createNktkasClient({ url: config.HYPERLIQUID_API_URL });
        const operator = keyring.operator();
        const master = keyring.perpAddressAt(0);

        const [balance, sending, toPool, masterState] = await Promise.all([
            arc.getBalance({ address: operator.address }),
            database.collections.withdrawals.find({ state: "sending" }).toArray(),
            database.collections.poolRebalances.find({ direction: "arc_to_polygon", state: "sending" }).toArray(),
            hl.state(master),
        ]);
        const owed = owedOf({ withdrawals: sending, poolRows: toPool });
        const treasuryE6 = weiToE6(balance);
        const needE6 = weiToE6(owed + TREASURY_GAS_RESERVE) + reserveE6;
        console.log(`Arc treasury ${operator.address}: ${dollars(treasuryE6)}, withdrawals need ${dollars(needE6)}`);
        console.log(`Hyperliquid master ${master}: ${dollars(masterState?.withdrawableE6 ?? 0n)} free`);

        const plan = planRebalance({ direction, amountE6, treasuryFreeE6: treasuryE6, withdrawalNeedE6: needE6 });
        if (!plan.ok) {
            console.error(plan.reason);
            process.exitCode = 1;
            return;
        }
        if (direction === "arc-to-hl") await arcToHl();
        else await hlToArc();

        async function arcToHl() {
            const forwarder = process.env.HYPERCORE_CCTP_FORWARDER?.trim() as Address | undefined;
            if (!forwarder) throw new Error("Set HYPERCORE_CCTP_FORWARDER to the CctpForwarder address on HyperEVM.");
            const fees = await fetch(
                `${config.CIRCLE_IRIS_URL}/v2/burn/USDC/fees/${ARC_DOMAIN}/${HYPEREVM_DOMAIN}?forward=true&hyperCoreDeposit=true`,
            ).then((response) => response.json() as Promise<FeeRow[] | { data?: FeeRow[] }>);
            const rows = Array.isArray(fees) ? fees : (fees.data ?? []);
            const maxFee = maxFeeOf(
                amountE6,
                rows.find((r) => r.finalityThreshold === STANDARD_FINALITY) ?? rows[0] ?? {},
            );
            const hookData = buildHookData(master);
            console.log(
                `Burn ${dollars(amountE6)} on Arc, mint to HyperCore perps for ${master}; max fee ${dollars(maxFee)}`,
            );
            console.log(`Forwarder ${forwarder}; hook data ${hookData}`);
            if (!send) return void console.log("Nothing sent. Add --yes-send-real-money to send.");

            const [nonce, block] = await Promise.all([
                arc.getTransactionCount({ address: operator.address, blockTag: "pending" }),
                arc.getBlock(),
            ]);
            const doubled = (block.baseFeePerGas ?? 0n) * 2n;
            const sign = (n: number, to: Address, data: Hex, gas: bigint) =>
                operator.signTransaction({
                    type: "eip1559",
                    chainId: ARC_CHAIN_ID,
                    nonce: n,
                    to,
                    value: 0n,
                    data,
                    gas,
                    maxFeePerGas: doubled > MIN_BASE_FEE ? doubled : MIN_BASE_FEE,
                    maxPriorityFeePerGas: PRIORITY_FEE,
                });
            const approve = await sign(nonce, ARC_USDC_ERC20, encodeApprove(amountE6, TOKEN_MESSENGER_V2), APPROVE_GAS);
            const approved = await arc.sendRawTransaction({ serializedTransaction: approve });
            await arc.waitForTransactionReceipt({ hash: approved });
            const burn = await sign(
                nonce + 1,
                TOKEN_MESSENGER_V2,
                encodeFunctionData({
                    abi: BURN_ABI,
                    functionName: "depositForBurnWithHook",
                    args: [
                        amountE6,
                        HYPEREVM_DOMAIN,
                        pad(forwarder, { size: 32 }),
                        ARC_USDC_ERC20,
                        pad(forwarder, { size: 32 }),
                        maxFee,
                        STANDARD_FINALITY,
                        hookData,
                    ],
                }),
                BURN_GAS,
            );
            const hash = await arc.sendRawTransaction({ serializedTransaction: burn });
            console.log(`Burn sent: ${hash}`);
            const receipt = await arc.waitForTransactionReceipt({ hash });
            const mined = await recordIfMined(receipt.status, () => record("arc_to_hl", hash));
            console.log(mined ? "Mined; the float shows it once Circle forwards it." : "The burn reverted.");
        }

        async function hlToArc() {
            const data = buildWithdrawData(ARC_DOMAIN);
            console.log(
                `Withdraw ${dollars(amountE6)} from the master to ${operator.address} on Arc through Circle's forwarder`,
            );
            console.log(`Forwarding data ${data} (unverified for Arc, see the header)`);
            if (!send) return void console.log("Nothing sent. Add --yes-send-real-money to send.");
            const nonce = nextNonce(master);
            await sendToEvmWithData({
                url: config.HYPERLIQUID_API_URL,
                signer: keyring.perpSignerAt(0),
                to: operator.address,
                amountE6,
                destinationChainId: ARC_CHAIN_ID,
                gasLimit: WITHDRAW_GAS_LIMIT,
                data,
                nonce,
            });
            await record("hl_to_arc", keccak256(toHex(`hl-to-arc:${nonce}`)));
            console.log(
                "Sent. It arrives on Arc once Circle forwards it; the row stays `sent` until you mark it arrived.",
            );
        }

        async function record(kind: "arc_to_hl" | "hl_to_arc", txHash: string) {
            await database.collections.perpRebalances.insertOne({
                _id: new ObjectId(),
                direction: kind,
                amountE6: toDecimal(amountE6),
                state: "sent",
                txHash,
                createdAt: new Date(),
            });
        }
    } finally {
        await database.close();
    }
}

if (import.meta.main) {
    await main().catch((error: unknown) => {
        console.error(describeError(error));
        process.exitCode = 1;
    });
}
