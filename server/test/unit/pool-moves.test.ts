import {
    decodeFunctionData,
    encodeAbiParameters,
    encodeEventTopics,
    pad,
    parseAbi,
    parseAbiItem,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import { expect, test } from "vitest";
import {
    DEPOSIT_FOR_BURN_EVENT,
    POLYGON,
    decodeBurnLog,
    unwrapAndBurnCalls,
    wrapCalls,
} from "../../src/predictions/pool-moves.ts";
import { FORWARD_HOOK_DATA } from "../../src/withdrawals/cctp-burn.ts";

const WALLET: Address = "0x00000000000000000000000000000000000a11ce";
const TREASURY: Address = "0x000000000000000000000000000000000000b0b0";
const AMOUNT = 12_000_000n;
const MAX_FEE = 213_201n;

const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const onramp = parseAbi(["function wrap(address asset, address to, uint256 amount)"]);
const offramp = parseAbi(["function unwrap(address asset, address to, uint256 amount)"]);
const messenger = parseAbi([
    "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);
const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const lower = (address: string) => address.toLowerCase();

test("POLYGON holds the addresses the spec names", () => {
    expect(POLYGON).toEqual({
        usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        pusd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
        onramp: "0x93070a847efEf7F70739046A929D47a521F5B8ee",
        offramp: "0x2957922Eb93258b93368531d39fAcCA3B4dC5854",
        tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
        conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
        negRiskAdapter: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
    });
});

test("wrapCalls is USDC.approve(onramp, x) then onramp.wrap(USDC, wallet, x)", () => {
    const calls = wrapCalls({ amountE6: AMOUNT, wallet: WALLET });
    expect(calls).toHaveLength(2);

    expect(calls[0]!.to).toBe(POLYGON.usdc);
    const approve = decodeFunctionData({ abi: erc20, data: calls[0]!.data });
    expect(approve.functionName).toBe("approve");
    expect(approve.args!.map((a) => (typeof a === "string" ? lower(a) : a))).toEqual([lower(POLYGON.onramp), AMOUNT]);

    expect(calls[1]!.to).toBe(POLYGON.onramp);
    const wrap = decodeFunctionData({ abi: onramp, data: calls[1]!.data });
    expect(wrap.functionName).toBe("wrap");
    expect(wrap.args!.map((a) => (typeof a === "string" ? lower(a) : a))).toEqual([
        lower(POLYGON.usdc),
        lower(WALLET),
        AMOUNT,
    ]);
});

test("unwrapAndBurnCalls has the four calls of 1.2 in order against the right targets", () => {
    const calls = unwrapAndBurnCalls({ amountE6: AMOUNT, maxFeeE6: MAX_FEE, wallet: WALLET, recipient: TREASURY });
    expect(calls.map((call) => call.to)).toEqual([POLYGON.pusd, POLYGON.offramp, POLYGON.usdc, POLYGON.tokenMessenger]);

    const first = decodeFunctionData({ abi: erc20, data: calls[0]!.data });
    expect(first.functionName).toBe("approve");
    expect(first.args!.map((a) => (typeof a === "string" ? lower(a) : a))).toEqual([lower(POLYGON.offramp), AMOUNT]);

    const second = decodeFunctionData({ abi: offramp, data: calls[1]!.data });
    expect(second.functionName).toBe("unwrap");
    expect(second.args!.map((a) => (typeof a === "string" ? lower(a) : a))).toEqual([
        lower(POLYGON.usdc),
        lower(WALLET),
        AMOUNT,
    ]);

    const third = decodeFunctionData({ abi: erc20, data: calls[2]!.data });
    expect(third.functionName).toBe("approve");
    expect(third.args!.map((a) => (typeof a === "string" ? lower(a) : a))).toEqual([
        lower(POLYGON.tokenMessenger),
        AMOUNT,
    ]);

    expect(decodeFunctionData({ abi: messenger, data: calls[3]!.data }).functionName).toBe("depositForBurnWithHook");
});

test("the fourth call burns native USDC to domain 26 with the treasury as mintRecipient, zero destinationCaller, finality 2000, the forwarding hook and the given maxFee", () => {
    const calls = unwrapAndBurnCalls({ amountE6: AMOUNT, maxFeeE6: MAX_FEE, wallet: WALLET, recipient: TREASURY });
    const { args } = decodeFunctionData({ abi: messenger, data: calls[3]!.data });
    const [amount, domain, mintRecipient, burnToken, destinationCaller, maxFee, finality, hook] = args as [
        bigint,
        number,
        Hex,
        Address,
        Hex,
        bigint,
        number,
        Hex,
    ];
    expect(amount).toBe(AMOUNT);
    expect(domain).toBe(26);
    expect(mintRecipient).toBe(pad(TREASURY, { size: 32 }));
    expect(lower(burnToken)).toBe(lower(POLYGON.usdc));
    expect(destinationCaller).toBe(pad("0x", { size: 32 }));
    expect(maxFee).toBe(MAX_FEE);
    expect(finality).toBe(2000);
    expect(hook).toBe(FORWARD_HOOK_DATA);
});

test("the encoders refuse a zero amount, a maxFee that isn't below the amount, and a zero recipient", () => {
    expect(() => wrapCalls({ amountE6: 0n, wallet: WALLET })).toThrow();
    expect(() => unwrapAndBurnCalls({ amountE6: 0n, maxFeeE6: 0n, wallet: WALLET, recipient: TREASURY })).toThrow();
    expect(() =>
        unwrapAndBurnCalls({ amountE6: AMOUNT, maxFeeE6: AMOUNT, wallet: WALLET, recipient: TREASURY }),
    ).toThrow();
    expect(() =>
        unwrapAndBurnCalls({ amountE6: AMOUNT, maxFeeE6: -1n, wallet: WALLET, recipient: TREASURY }),
    ).toThrow();
    expect(() =>
        unwrapAndBurnCalls({ amountE6: AMOUNT, maxFeeE6: MAX_FEE, wallet: WALLET, recipient: zeroAddress }),
    ).toThrow();
});

function burnLog(o: { depositor: Address; amountE6: bigint }): { topics: Hex[]; data: Hex } {
    const topics = encodeEventTopics({
        abi: [DEPOSIT_FOR_BURN_EVENT],
        eventName: "DepositForBurn",
        args: { burnToken: POLYGON.usdc, depositor: o.depositor, minFinalityThreshold: 2000 },
    });
    const data = encodeAbiParameters(
        [
            { type: "uint256" },
            { type: "bytes32" },
            { type: "uint32" },
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "uint256" },
            { type: "bytes" },
        ],
        [
            o.amountE6,
            pad(TREASURY, { size: 32 }),
            26,
            pad(POLYGON.tokenMessenger, { size: 32 }),
            pad("0x", { size: 32 }),
            MAX_FEE,
            FORWARD_HOOK_DATA,
        ],
    );
    return { topics: topics as Hex[], data };
}

test("decodeBurnLog reads depositor and amount from a log built with encodeEventTopics and ignores another event", () => {
    const decoded = decodeBurnLog(burnLog({ depositor: WALLET, amountE6: AMOUNT }));
    expect(decoded).not.toBeNull();
    expect(lower(decoded!.depositor)).toBe(lower(WALLET));
    expect(decoded!.amountE6).toBe(AMOUNT);

    const other = {
        topics: encodeEventTopics({
            abi: [transfer],
            eventName: "Transfer",
            args: { from: WALLET, to: TREASURY },
        }) as Hex[],
        data: encodeAbiParameters([{ type: "uint256" }], [AMOUNT]),
    };
    expect(decodeBurnLog(other)).toBeNull();
});

test("decodeBurnLog answers null for a log that doesn't decode", () => {
    expect(decodeBurnLog({ topics: [], data: "0x" })).toBeNull();
    const good = burnLog({ depositor: WALLET, amountE6: AMOUNT });
    expect(decodeBurnLog({ topics: good.topics, data: "0x1234" })).toBeNull();
    expect(decodeBurnLog({ topics: good.topics.slice(0, 2), data: good.data })).toBeNull();
});

test("the Polymarket contracts written here are the ones the SDK trades with", async () => {
    // The SDK's types hide its contract table, but production carries it at runtime
    const { production } = await import("@polymarket/client");
    const contracts = (production as unknown as { contracts: Record<string, string> }).contracts;
    expect(POLYGON.pusd).toBe(contracts.collateralToken);
    expect(POLYGON.conditionalTokens).toBe(contracts.conditionalTokens);
    expect(POLYGON.negRiskAdapter).toBe(contracts.negRiskAdapter);
});
