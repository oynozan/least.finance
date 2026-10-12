import { EventEmitter } from "node:events";
import type { ObjectId } from "mongodb";
import type { AccountDoc, DepositDoc, DepositOrderDoc } from "./db/mongo.ts";
import type { BalancesView } from "./protocol.ts";

type Events = {
    /** Fired once per deposit, after its transaction commits. */
    "deposit:credited": [{ deposit: DepositDoc; account: AccountDoc }];
    /** Fired when a bridge order is opened or changes state. */
    "order:updated": [{ order: DepositOrderDoc }];
    /** Fired after each read of an account's wallets. */
    "balances:updated": [{ accountId: ObjectId; privyUserId: string; view: BalancesView }];
};

/** In-process events between the ledger and the sockets. */
export class Bus extends EventEmitter<Events> {}
