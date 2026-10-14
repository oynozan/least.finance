import { decodeFunctionData, parseAbi, parseUnits, concatHex, type Hex } from "viem";
import { expect, test } from "vitest";
import {
    ARC_USDC_ERC20,
    FORWARD_HOOK_DATA,
    TOKEN_MESSENGER_V2,
    encodeApprove,
    encodeBurn,
    encodeBurnToEvm,
    maxFeeWithHeadroom,
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

const POOL_WALLET = "0x00000000000000000000000000000000000a11ce";
const TO_EVM = {
    amount6: 10_000_000n,
    domain: 7,
    recipient: POOL_WALLET,
    maxFee6: 213_201n,
} as const;

test("encodeBurnToEvm passes domain 7, the recipient left-padded to 32 bytes, zero destinationCaller, finality 2000 and the forwarding hook", () => {
    const data = encodeBurnToEvm(TO_EVM);
    expect(data).toBe(
        "0x779b432d" +
            "0000000000000000000000000000000000000000000000000000000000989680" + // amount: 10 USDC
            "0000000000000000000000000000000000000000000000000000000000000007" + // destination domain
            "00000000000000000000000000000000000000000000000000000000000a11ce" + // mintRecipient
            "0000000000000000000000003600000000000000000000000000000000000000" + // burnToken
            "0000000000000000000000000000000000000000000000000000000000000000" + // destinationCaller
            "00000000000000000000000000000000000000000000000000000000000340d1" + // maxFee
            "00000000000000000000000000000000000000000000000000000000000007d0" + // minFinalityThreshold
            "0000000000000000000000000000000000000000000000000000000000000100" + // hookData offset
            "0000000000000000000000000000000000000000000000000000000000000020" + // hookData length
            "636374702d666f72776172640000000000000000000000000000000000000000", // "cctp-forward", version 0
    );
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
    expect(amount).toBe(10_000_000n);
    expect(domain).toBe(7);
    expect(recipient).toBe(`0x${"00".repeat(12)}${POOL_WALLET.slice(2)}`);
    expect(token.toLowerCase()).toBe(ARC_USDC_ERC20.toLowerCase());
    expect(caller).toBe(`0x${"00".repeat(32)}`);
    expect(maxFee).toBe(213_201n);
    expect(finality).toBe(2000);
    expect(hook).toBe(FORWARD_HOOK_DATA);
});

test("burnToken can be overridden", () => {
    const polygonUsdc = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
    const { args } = decodeFunctionData({
        abi,
        data: encodeBurnToEvm({ ...TO_EVM, domain: 26, burnToken: polygonUsdc }),
    });
    expect((args![3] as string).toLowerCase()).toBe(polygonUsdc.toLowerCase());
    expect(args![1]).toBe(26);
});

test("encodeBurnToEvm refuses a recipient that isn't an address or is the zero address", () => {
    expect(() => encodeBurnToEvm({ ...TO_EVM, recipient: "0x1234" })).toThrow();
    expect(() => encodeBurnToEvm({ ...TO_EVM, recipient: `0x${"00".repeat(20)}` })).toThrow();
});

test("maxFeeWithHeadroom: high 71_067 on 10 USDC gives 213_201", () => {
    expect(maxFeeWithHeadroom({ amount6: 10_000_000n, high6: 71_067n, minimumFeeBps: 0 })).toBe(213_201n);
});

test("high 16_288 gives 116_288 (the additive branch)", () => {
    expect(maxFeeWithHeadroom({ amount6: 10_000_000n, high6: 16_288n, minimumFeeBps: 0 })).toBe(116_288n);
});

test("the protocol basis points add on top", () => {
    expect(maxFeeWithHeadroom({ amount6: 10_000_000n, high6: 71_067n, minimumFeeBps: 1 })).toBe(214_201n);
});

test("it is clamped below the amount", () => {
    expect(maxFeeWithHeadroom({ amount6: 100_000n, high6: 71_067n, minimumFeeBps: 0 })).toBe(99_999n);
});

test("fractional basis points round up", () => {
    const fee = (minimumFeeBps: number) => maxFeeWithHeadroom({ amount6: 10_000_000n, high6: 71_067n, minimumFeeBps });
    expect(fee(1.3)).toBe(213_201n + 1_300n);
    expect(fee(1.1)).toBe(213_201n + 1_100n);
    expect(fee(0.01)).toBe(213_201n + 10n);
    // The rate rounds up to a hundredth of a basis point
    expect(fee(0.001)).toBe(213_201n + 10n);
});

test("maxFeeWithHeadroom refuses a negative or non-finite rate and an empty amount", () => {
    const base = { amount6: 10_000_000n, high6: 71_067n, minimumFeeBps: 0 };
    expect(() => maxFeeWithHeadroom({ ...base, minimumFeeBps: -1 })).toThrow();
    expect(() => maxFeeWithHeadroom({ ...base, minimumFeeBps: NaN })).toThrow();
    expect(() => maxFeeWithHeadroom({ ...base, amount6: 0n })).toThrow();
});
