import type { ObjectId } from "mongodb";
import type { Logger } from "pino";
import type { Address } from "viem";
import type { Identity, IdentityProvider } from "../auth/identity.ts";
import type { AccountDoc } from "../db/mongo.ts";
import type { Bus } from "../events.ts";
import type { BalancesView, CoinBalance } from "../protocol.ts";

/** An account's balances are read at most this often, however many tabs click Deposit. */
export const REFRESH_INTERVAL_MS = 30_000;
/** Inside that window, Privy is asked for newly linked wallets at most this often per account. */
const LINK_CHECK_MS = 5_000;

type Deps = {
    identity: IdentityProvider;
    bus: Bus;
    logger: Logger;
    readEvm(owner: Address): Promise<CoinBalance[]>;
    readSolana(owner: string): Promise<CoinBalance[]>;
    now?: () => number;
};

type Linked = { evm: Address[]; solana: string[] };

type State = {
    rows: CoinBalance[];
    /** When the 30 s window started: the last read of every wallet. */
    readAt: number;
    /** When linked wallets were last fetched fresh from Privy. */
    checkedAt: number;
    linked: Linked;
};

/** Each account's coin balances, read when the socket binds and again on Deposit, at most once per 30 s. */
export class WalletBalances {
    readonly #deps: Deps;
    readonly #now: () => number;
    readonly #states = new Map<string, State>();
    readonly #running = new Map<string, Promise<{ read: boolean; emitted: boolean }>>();

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    /**
     * "click": reads only past REFRESH_INTERVAL_MS, or at once for a linked wallet with no rows yet.
     * "bind": the same, except that a socket with nothing to read still ends up holding the account's
     * view: `push` is called with it when no read emitted one to the room.
     */
    async refresh(
        account: AccountDoc,
        identity: Identity,
        reason: "bind" | "click",
        push?: (view: BalancesView) => void,
    ): Promise<{ read: boolean }> {
        const key = account._id.toHexString();
        let work = this.#running.get(key);
        if (!work) {
            work = this.#run(account, identity, reason).finally(() => this.#running.delete(key));
            this.#running.set(key, work);
        }
        const result = await work;
        if (reason === "bind" && !result.emitted) {
            const held = this.last(account._id);
            if (held) push?.(held);
        }
        return { read: result.read };
    }

    last(accountId: ObjectId): BalancesView | null {
        const state = this.#states.get(accountId.toHexString());
        return state ? view(state) : null;
    }

    async #run(
        account: AccountDoc,
        identity: Identity,
        reason: "bind" | "click",
    ): Promise<{ read: boolean; emitted: boolean }> {
        const key = account._id.toHexString();
        const state = this.#states.get(key);
        const now = this.#now();
        const due = !state || now - state.readAt >= REFRESH_INTERVAL_MS;

        // A click always asks Privy afresh past the window, and inside it at most once per 5 s.
        const check = reason === "click" && (due || now - (state?.checkedAt ?? 0) >= LINK_CHECK_MS);
        let linked: Linked;
        if (check) {
            try {
                linked = await this.#deps.identity.linkedWallets(identity, { fresh: true });
            } catch (error) {
                // Privy can't answer: use the last list read.
                this.#deps.logger.warn({ err: error }, "Couldn't check linked wallets afresh");
                linked = state?.linked ?? (await this.#deps.identity.linkedWallets(identity));
            }
        } else {
            linked = due ? await this.#deps.identity.linkedWallets(identity) : state!.linked;
        }
        const checkedAt = check ? now : (state?.checkedAt ?? 0);

        const wallets = [
            ...linked.evm.map((address) => ({ address, evm: true })),
            ...linked.solana.map((address) => ({ address, evm: false })),
        ];
        const known = new Set((state?.rows ?? []).map((row) => row.wallet));
        const toRead = due ? wallets : wallets.filter(({ address }) => !known.has(address));

        const fresh = new Map<string, CoinBalance[]>();
        await Promise.all(
            toRead.map(async ({ address, evm }) => {
                try {
                    fresh.set(
                        address,
                        evm ? await this.#deps.readEvm(address as Address) : await this.#deps.readSolana(address),
                    );
                } catch (error) {
                    this.#deps.logger.warn({ err: error, wallet: address }, "Couldn't read a wallet's balances");
                }
            }),
        );

        // Only linked wallets survive; a null amount keeps the last known row for that wallet and coin.
        const before = new Map<string, CoinBalance>(
            (state?.rows ?? []).map((row) => [`${row.wallet}|${row.coin}`, row]),
        );
        const rows = wallets.flatMap(({ address }) => {
            const read = fresh.get(address);
            if (!read) return (state?.rows ?? []).filter((row) => row.wallet === address);
            return read.map((row) => (row.amount === null ? (before.get(`${row.wallet}|${row.coin}`) ?? row) : row));
        });

        const dropped = (state?.rows ?? []).some((row) => !wallets.some(({ address }) => address === row.wallet));
        const next: State = { rows, readAt: due ? now : state!.readAt, checkedAt, linked };
        this.#states.set(key, next);
        if (fresh.size === 0 && !dropped && !due) return { read: false, emitted: false };
        this.#deps.bus.emit("balances:updated", {
            accountId: account._id,
            privyUserId: account.privyUserId,
            view: view(next),
        });
        return { read: fresh.size > 0, emitted: true };
    }
}

const view = (state: State): BalancesView => ({ readAt: new Date(state.readAt).toISOString(), rows: state.rows });
