import { decodeEventLog, encodeFunctionData, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { ARC_DOMAIN } from "../crosschain/iris.ts";
import { encodeApprove, encodeBurnToEvm } from "../withdrawals/cctp-burn.ts";

/** The Polygon contracts the pool's batches call; the one place their addresses are written. */
export const POLYGON = {
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    pusd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
    onramp: "0x93070a847efEf7F70739046A929D47a521F5B8ee",
    offramp: "0x2957922Eb93258b93368531d39fAcCA3B4dC5854",
    tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
} as const;

export type Call = { to: Address; data: Hex };

const ramps = parseAbi([
    "function wrap(address asset, address to, uint256 amount)",
    "function unwrap(address asset, address to, uint256 amount)",
]);

/** TokenMessengerV2's burn event, as declared in TokenMessengerV2.sol. */
export const DEPOSIT_FOR_BURN_EVENT = parseAbiItem(
    "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
);

/** Wraps native USDC the deposit wallet holds into pUSD: approve the Onramp, then wrap. */
export function wrapCalls(o: { amountE6: bigint; wallet: Address }): Call[] {
    if (o.amountE6 <= 0n) throw new Error("The amount must be above zero");
    return [
        { to: POLYGON.usdc, data: encodeApprove(o.amountE6, POLYGON.onramp) },
        {
            to: POLYGON.onramp,
            data: encodeFunctionData({
                abi: ramps,
                functionName: "wrap",
                args: [POLYGON.usdc, o.wallet, o.amountE6],
            }),
        },
    ];
}

/** Turns pUSD into native USDC in the deposit wallet and burns it for the recipient on Arc, in this order. */
export function unwrapAndBurnCalls(o: {
    amountE6: bigint;
    maxFeeE6: bigint;
    wallet: Address;
    recipient: Address;
}): Call[] {
    if (o.amountE6 <= 0n) throw new Error("The amount must be above zero");
    if (o.maxFeeE6 < 0n || o.maxFeeE6 >= o.amountE6) throw new Error("The maxFee must be below the amount");
    return [
        { to: POLYGON.pusd, data: encodeApprove(o.amountE6, POLYGON.offramp) },
        {
            to: POLYGON.offramp,
            data: encodeFunctionData({
                abi: ramps,
                functionName: "unwrap",
                args: [POLYGON.usdc, o.wallet, o.amountE6],
            }),
        },
        { to: POLYGON.usdc, data: encodeApprove(o.amountE6, POLYGON.tokenMessenger) },
        {
            to: POLYGON.tokenMessenger,
            data: encodeBurnToEvm({
                amount6: o.amountE6,
                domain: ARC_DOMAIN,
                recipient: o.recipient,
                maxFee6: o.maxFeeE6,
                burnToken: POLYGON.usdc,
            }),
        },
    ];
}

/** The depositor and amount of a DepositForBurn log; null for any other log (the caller scopes the log to TokenMessengerV2). */
export function decodeBurnLog(log: { topics: Hex[]; data: Hex }): { depositor: Address; amountE6: bigint } | null {
    try {
        const decoded = decodeEventLog({
            abi: [DEPOSIT_FOR_BURN_EVENT],
            topics: log.topics as [Hex, ...Hex[]],
            data: log.data,
        });
        return { depositor: decoded.args.depositor, amountE6: decoded.args.amount };
    } catch {
        return null;
    }
}
