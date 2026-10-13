import { decodeFunctionData, parseAbi, parseUnits, concatHex, type Hex } from "viem";
import { expect, test } from "vitest";
import {
    ARC_USDC_ERC20,
    FORWARD_HOOK_DATA,
    TOKEN_MESSENGER_V2,
    encodeApprove,
    encodeBurn,
    weiToUsdc6,
} from "../../src/withdrawals/cctp-burn.ts";
import { SOLANA_USDC_MINT, solanaBytes32 } from "../../src/withdrawals/solana-recipient.ts";

const abi = parseAbi([
    "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
    "function approve(address spender, uint256 amount)",
]);
const USDC_ACCOUNT = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

test("encodeBurn passes domain 5, minFinalityThreshold 2000 and the derived account as mintRecipient", () => {
    for (const setup of [false, true]) {
        const data = encodeBurn({
            amount6: 9_000_000n,
            usdcAccount: USDC_ACCOUNT,
            wallet: WALLET,
            setup,
            maxFee6: 150_000n,
        });
        const { functionName, args } = decodeFunctionData({ abi, data });
        expect(functionName).toBe("depositForBurnWithHook");
        const [amount, domain, recipient, token, caller, maxFee, finality, hook] = args as [
            bigint,
            number,
            Hex,
            Hex,
            Hex,
            bigint,
            number,
            Hex,
        ];
        expect(amount).toBe(9_000_000n);
        expect(domain).toBe(5);
        expect(recipient).toBe(solanaBytes32(USDC_ACCOUNT));
        expect(token.toLowerCase()).toBe(ARC_USDC_ERC20.toLowerCase());
        expect(caller).toBe(`0x${"00".repeat(32)}`);
        expect(maxFee).toBe(150_000n);
        expect(finality).toBe(2000);
        if (setup) {
            expect(hook).toBe(
                concatHex([
                    "0x636374702d666f7277617264", // "cctp-forward"
                    `0x${"00".repeat(12)}`,
                    "0x00000000", // version 0
                    "0x00000021", // 33 bytes follow
                    "0x01",
                    solanaBytes32(WALLET),
                ]),
            );
        } else {
            expect(hook).toBe(FORWARD_HOOK_DATA);
        }
    }
});

test("encodeApprove approves the TokenMessengerV2 for the amount", () => {
    const { functionName, args } = decodeFunctionData({ abi, data: encodeApprove(5_000_000n) });
    expect(functionName).toBe("approve");
    expect((args![0] as string).toLowerCase()).toBe(TOKEN_MESSENGER_V2.toLowerCase());
    expect(args![1]).toBe(5_000_000n);
});

test("weiToUsdc6 converts 12.5 USDC wei exactly and rejects dust", () => {
    expect(weiToUsdc6(parseUnits("12.5", 18))).toBe(12_500_000n);
    expect(() => weiToUsdc6(parseUnits("12.5", 18) + 1n)).toThrow();
    expect(SOLANA_USDC_MINT).toBeTruthy();
});
