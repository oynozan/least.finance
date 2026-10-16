import { EventEmitter } from "node:events";
import type { ObjectId } from "mongodb";
import type {
    AccountDoc,
    DepositDoc,
    DepositOrderDoc,
    PerpOrderDoc,
    PerpPositionDoc,
    PoolRebalanceDoc,
    PositionDoc,
    PredictionOrderDoc,
    WithdrawalDoc,
} from "./db/mongo.ts";
import type { BalancesView } from "./protocol.ts";
import type { CoinWithdrawalDoc } from "./trading/docs.ts";

type Events = {
    /** Fired once per deposit, after its transaction commits. */
    "deposit:credited": [{ deposit: DepositDoc; account: AccountDoc }];
    /** Fired when a bridge order is opened or changes state. */
    "order:updated": [{ order: DepositOrderDoc }];
    /** Fired after each read of an account's wallets. */
    "balances:updated": [{ accountId: ObjectId; privyUserId: string; view: BalancesView }];
    /** Fired after a prediction order settles, once its transaction commits. */
    "prediction:updated": [{ order: PredictionOrderDoc; position: PositionDoc | null; account: AccountDoc }];
    /** Fired when a perp order changes state, once the change has committed. */
    "perp:updated": [{ order: PerpOrderDoc; position: PerpPositionDoc | null; account: AccountDoc }];
    /** Fired after a position is paid or lost at its market's resolution, once its transaction commits. */
    "position:settled": [{ position: PositionDoc; account: AccountDoc }];
    /** Fired when a withdrawal is created or changes state. */
    "withdrawal:updated": [{ withdrawal: WithdrawalDoc; account: AccountDoc | null }];
    /** Fired when a coin withdrawal is sent or fails; `refunded` is true when its units went back to the holding. */
    "coin-withdrawal:updated": [{ withdrawal: CoinWithdrawalDoc; refunded: boolean }];
    /** Fired when a pool rebalance is queued or changes state. */
    "pool-rebalance:updated": [{ rebalance: PoolRebalanceDoc }];
};

/** In-process events between the ledger and the sockets. */
export class Bus extends EventEmitter<Events> {}
