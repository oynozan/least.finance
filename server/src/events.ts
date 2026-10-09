import { EventEmitter } from "node:events";
import type { AccountDoc, DepositDoc } from "./db/mongo.ts";

type Events = {
    /** Fired once per deposit, after its transaction commits. */
    "deposit:credited": [{ deposit: DepositDoc; account: AccountDoc }];
};

/** In-process events between the ledger and the sockets. */
export class Bus extends EventEmitter<Events> {}
