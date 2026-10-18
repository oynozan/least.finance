import { ObjectId } from "mongodb";
import { pino } from "pino";
import { expect, test, vi } from "vitest";
import { WalletBalances } from "../../src/balances/wallet-balances.ts";
import type { AccountDoc } from "../../src/db/mongo.ts";
import { EventEmitter } from "node:events";

const account = { _id: new ObjectId(), privyUserId: "did:privy:abc" } as unknown as AccountDoc;
const identity = { userId: "did:privy:abc" } as never;

function build(overrides: object) {
    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const balances = new WalletBalances({
        identity: { linkedWallets: async () => ({ evm: [], solana: [] }) } as never,
        bus: new EventEmitter() as never,
        logger,
        readEvm: async () => [],
        readSolana: async () => [],
        ...overrides,
    });
    return { balances, warn };
}

test("a wallet that can't be read is logged with the account it belongs to", async () => {
    const { balances, warn } = build({
        identity: { linkedWallets: async () => ({ evm: ["0xabc"], solana: [] }) },
        readEvm: async () => {
            throw new Error("rpc down");
        },
    });
    await balances.refresh(account, identity, "bind");
    expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
            accountId: account._id.toHexString(),
            privyUserId: "did:privy:abc",
            wallet: "0xabc",
        }),
        "Couldn't read a wallet's balances",
    );
});

test("when Privy can't list wallets even the second time, the person is told so and the log names the account", async () => {
    const { balances, warn } = build({
        identity: {
            linkedWallets: async () => {
                throw new Error("privy 503");
            },
        },
    });
    const error = await balances.refresh(account, identity, "click").catch((e: unknown) => e);
    expect(error).toMatchObject({
        code: "unavailable",
        message: "Privy didn't answer, so your wallets couldn't be listed. Try again in a moment.",
        logged: true,
    });
    expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: account._id.toHexString(), err: expect.any(Error) }),
        "Couldn't read the linked wallets from Privy",
    );
});
