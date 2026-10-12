import { EventEmitter } from "node:events";
import type { ObjectId } from "mongodb";
import type { AccountDoc, DepositDoc, DepositOrderDoc, PositionDoc, PredictionOrderDoc } from "./db/mongo.ts";
import type { BalancesView, SwapHoldingsView } from "./protocol.ts";

type Events = {
    /** Fired once per deposit, after its transaction commits. */
    "deposit:credited": [{ deposit: DepositDoc; account: AccountDoc }];
    /** Fired when a bridge order is opened or changes state. */
    "order:updated": [{ order: DepositOrderDoc }];
    /** Fired after each read of an account's wallets. */
    "balances:updated": [{ accountId: ObjectId; privyUserId: string; view: BalancesView }];
    /** Fired after each read of an account's swap holdings. */
    "swap:holdings": [{ accountId: ObjectId; privyUserId: string; view: SwapHoldingsView }];
    /** Fired after a prediction order settles, once its transaction commits. */
    "prediction:updated": [{ order: PredictionOrderDoc; position: PositionDoc | null; account: AccountDoc }];
    /** Fired after a position is paid or lost at its market's resolution, once its transaction commits. */
    "position:settled": [{ position: PositionDoc; account: AccountDoc }];
};

/** In-process events between the ledger and the sockets. */
export class Bus extends EventEmitter<Events> {}
