import {
    concatHex,
    encodeFunctionData,
    isAddress,
    isAddressEqual,
    pad,
    parseAbi,
    toHex,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import { SOLANA_DOMAIN } from "../crosschain/iris.ts";
import { solanaBytes32 } from "./solana-recipient.ts";

export const TOKEN_MESSENGER_V2: Address = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
export const ARC_USDC_ERC20: Address = "0x3600000000000000000000000000000000000000";
/** Standard finality, the speed the quoted fee is for. */
const MIN_FINALITY_THRESHOLD = 2000;
/** USDC wei (18 decimals) per ERC-20 unit (6 decimals). */
const WEI_PER_UNIT = 10n ** 12n;

const abi = parseAbi([
    "function approve(address spender, uint256 amount) returns (bool)",
    "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

/** Circle's forwarding hook data with nothing extra: "cctp-forward", version 0, length 0. */
export const FORWARD_HOOK_DATA: Hex = "0x636374702d666f72776172640000000000000000000000000000000000000000";

/** The forwarding hook that also asks for the recipient's USDC account to be created (version 0, 33 bytes: flag 1 and the owner). */
function setupHookData(wallet: string): Hex {
    return concatHex([
        FORWARD_HOOK_DATA.slice(0, 2 + 48) as Hex,
        "0x00000000",
        toHex(33, { size: 4 }),
        "0x01",
        solanaBytes32(wallet),
    ]);
}

/** The amounts or recipient of a burn can never be encoded, so retrying would never help. */
export class BurnInputError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "BurnInputError";
    }
}

/** The USDC ERC-20 view's approve for the TokenMessengerV2 (or the given spender). */
export function encodeApprove(amount6: bigint, spender: Address = TOKEN_MESSENGER_V2): Hex {
    return encodeFunctionData({ abi, functionName: "approve", args: [spender, amount6] });
}

/** A burn of Arc USDC minted by Circle's forwarder to the wallet's USDC account on Solana. */
export function encodeBurn(input: {
    amount6: bigint;
    usdcAccount: string;
    wallet: string;
    setup: boolean;
    maxFee6: bigint;
    burnToken?: Address;
}): Hex {
    return encodeFunctionData({
        abi,
        functionName: "depositForBurnWithHook",
        args: [
            input.amount6,
            SOLANA_DOMAIN,
            solanaBytes32(input.usdcAccount),
            input.burnToken ?? ARC_USDC_ERC20,
            pad("0x", { size: 32 }),
            input.maxFee6,
            MIN_FINALITY_THRESHOLD,
            input.setup ? setupHookData(input.wallet) : FORWARD_HOOK_DATA,
        ],
    });
}

/** A burn minted by Circle's forwarder to an address on an EVM chain, 32-byte padded as the mint recipient. */
export function encodeBurnToEvm(input: {
    amount6: bigint;
    domain: number;
    recipient: Address;
    maxFee6: bigint;
    burnToken?: Address;
}): Hex {
    if (!isAddress(input.recipient) || isAddressEqual(input.recipient, zeroAddress)) {
        throw new BurnInputError(`The mint recipient ${input.recipient} isn't a usable address`);
    }
    return encodeFunctionData({
        abi,
        functionName: "depositForBurnWithHook",
        args: [
            input.amount6,
            input.domain,
            pad(input.recipient, { size: 32 }),
            input.burnToken ?? ARC_USDC_ERC20,
            pad("0x", { size: 32 }),
            input.maxFee6,
            MIN_FINALITY_THRESHOLD,
            FORWARD_HOOK_DATA,
        ],
    });
}

/** The most Circle may take for a burn: three times the high forwarding fee (at least $0.10 more), plus the protocol's basis points, always below the amount. */
export function maxFeeWithHeadroom(input: { amount6: bigint; high6: bigint; minimumFeeBps: number }): bigint {
    if (input.amount6 <= 0n) throw new BurnInputError(`The amount must be above zero, got ${input.amount6}`);
    if (!Number.isFinite(input.minimumFeeBps) || input.minimumFeeBps < 0)
        throw new BurnInputError(`Bad protocol fee rate: ${input.minimumFeeBps}`);
    const forwarding = input.high6 * 3n > input.high6 + 100_000n ? input.high6 * 3n : input.high6 + 100_000n;
    const hundredthsOfBps = BigInt(Math.ceil(Number((input.minimumFeeBps * 100).toFixed(6))));
    const protocol = (input.amount6 * hundredthsOfBps + 999_999n) / 1_000_000n;
    const fee = forwarding + protocol;
    return fee < input.amount6 ? fee : input.amount6 - 1n;
}

/** Wei to ERC-20 units, exactly; dust below a unit can't be burned. */
export function weiToUsdc6(wei: bigint): bigint {
    if (wei % WEI_PER_UNIT !== 0n) throw new BurnInputError(`Amount ${wei} wei isn't a whole number of USDC units`);
    return wei / WEI_PER_UNIT;
}
