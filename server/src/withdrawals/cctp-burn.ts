import { concatHex, encodeFunctionData, pad, parseAbi, toHex, type Address, type Hex } from "viem";
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

/** Wei to ERC-20 units, exactly; dust below a unit can't be burned. */
export function weiToUsdc6(wei: bigint): bigint {
    if (wei % WEI_PER_UNIT !== 0n) throw new Error("Amount isn't a whole number of USDC units");
    return wei / WEI_PER_UNIT;
}
