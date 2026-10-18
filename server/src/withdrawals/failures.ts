import type { ObjectId } from "mongodb";
import { networkSays, refused, upstreamLine } from "../trading/send-errors.ts";

/** The sentence that ends a failed withdrawal: where the money is. */
export const BALANCE_BACK = "Your balance is back.";

/** Where in the payout a failure happened: the plain transfer, or the approve and the burn of a Solana withdrawal. */
export type PayoutStep = "pay" | "approve" | "burn";

/** The short reference a person can quote; it is the tail of the withdrawal id, so grepping the log for it finds the withdrawal. */
export const withdrawalRef = (id: ObjectId) => id.toHexString().slice(-6);

/** Why a payout failed: what is stored on it, what the person is told, and what the log says. */
export type Why = {
    /** Stored as `failure`. */
    failure: string;
    /** Stored as `detail`: the upstream's own words, or our explanation. */
    detail: string;
    /** Stored as `message` and shown to the person, also after a reload. */
    message: string;
    /** `warn` for a clear refusal, `error` for something we don't recognise. */
    level: "warn" | "error";
    step: PayoutStep;
    txHash: string | null;
    err?: unknown;
};

const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-4)}`;

/** The node turned a transaction down. A clear refusal is `warn`; anything else that ended the payout after repeated passes is `error`. */
export function networkRefused(error: unknown, step: PayoutStep, txHash: string | null): Why {
    return {
        failure: "Rejected by the network",
        detail: upstreamLine(error),
        message: `${networkSays(error)} ${BALANCE_BACK}`,
        level: refused(error) ? "warn" : "error",
        step,
        txHash,
        err: error,
    };
}

/** A transaction was mined and reverted. */
export function reverted(step: PayoutStep, txHash: string, gasUsed: bigint | null): Why {
    const gas = gasUsed === null ? "" : ` (gas used ${gasUsed})`;
    const message =
        step === "burn"
            ? `Circle's burn contract reverted the transfer to Solana (tx ${shortHash(txHash)}). ${BALANCE_BACK}`
            : step === "approve"
              ? `Approving the USDC for Circle was reverted on Arc (tx ${shortHash(txHash)}). ${BALANCE_BACK}`
              : `The payout was reverted on Arc (tx ${shortHash(txHash)}). ${BALANCE_BACK}`;
    return {
        failure:
            step === "burn"
                ? "Burn reverted on the network"
                : step === "approve"
                  ? "Approval reverted on the network"
                  : "Reverted on the network",
        detail: `Transaction ${txHash} reverted on Arc${gas}`,
        message,
        level: "warn",
        step,
        txHash,
    };
}

/** The burn's amounts or recipient could never be encoded, so the withdrawal can't go out. */
export function unsendable(error: unknown): Why {
    return {
        failure: "Couldn't build the transfer",
        detail: upstreamLine(error),
        message: `Something is wrong with this withdrawal's details on our side, so it was cancelled. ${BALANCE_BACK}`,
        level: "error",
        step: "burn",
        txHash: null,
        err: error,
    };
}

/** What a rebalance row keeps as `lastError`: the short phrase and what the upstream said. */
export const rebalanceError = (why: Pick<Why, "failure" | "detail">) => `${why.failure}: ${why.detail}`;

/** What Circle's forwarder reported when delivery to the Solana wallet failed, for the person. */
export const forwardFailedMessage = (ref: string) =>
    `Circle reported that delivering to your Solana wallet failed (ref ${ref}). We've been alerted.`;

/** Slow, not failed: what is waited on, for how long, and that the USDC is safe. */
export const forwardSlowMessage = (ref: string) =>
    `Still waiting for Circle to deliver to Solana (usually under 2 minutes, now over 15). Your USDC is safe, ref ${ref}.`;
