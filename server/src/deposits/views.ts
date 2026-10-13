import { getAddress } from "viem";
import type { AccountDoc, DepositDoc } from "../db/mongo.ts";
import { formatUsdc, fromDecimal } from "../db/money.ts";
import type { AccountView, DepositView, Hex } from "../protocol.ts";

export const accountView = (account: AccountDoc): AccountView => ({
    depositAddress: getAddress(account.depositAddress),
    balance: formatUsdc(fromDecimal(account.balance)),
    version: account.version,
});

export const depositView = (deposit: DepositDoc): DepositView => ({
    id: deposit._id.toHexString(),
    txHash: deposit.txHash as Hex,
    logIndex: deposit.logIndex,
    from: getAddress(deposit.from),
    amount: formatUsdc(fromDecimal(deposit.amount)),
    blockNumber: deposit.blockNumber,
    creditedAt: deposit.creditedAt.toISOString(),
    ...(deposit.origin && {
        origin: { coin: deposit.origin.coin, amount: deposit.origin.amount, txHash: deposit.origin.txHash },
    }),
});
